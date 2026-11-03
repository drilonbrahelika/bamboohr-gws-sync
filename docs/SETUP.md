# Setup guide

This guide takes you from nothing to a scheduled, monitored sync. It takes about 30 minutes, and most of that is clicking through the Google consoles.

- [How it fits together](#how-it-fits-together)
- [Prerequisites](#prerequisites)
- [1. BambooHR API key](#1-bamboohr-api-key)
- [2. Google Cloud service account](#2-google-cloud-service-account)
- [3. Domain-wide delegation](#3-domain-wide-delegation)
- [4. Deploy](#4-deploy)
- [5. First run in the console](#5-first-run-in-the-console)
- [6. Configure the sync](#6-configure-the-sync)
- [7. Roll out safely](#7-roll-out-safely)
- [8. Alerts](#8-alerts)
- [Configuration reference](#configuration-reference)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)

## How it fits together

```
           BambooHR API                                Google Admin SDK
   (custom report, Basic auth)          (service account + domain-wide delegation)
               │                                            ▲
               ▼                                            │
   ┌────────────────────────────────────────────────────────────────┐
   │  fetch employees ─┐                                            │
   │                   ├─► plan (pure diff) ─► apply (bounded,      │
   │  fetch users ─────┘                        retried, guarded)   │
   │                                                                │
   │  Hono API + console · scheduler (cron) · CLI · Slack alerts    │
   │  DATA_DIR: settings.json · secrets.enc.json · runs/*.json      │
   └────────────────────────────────────────────────────────────────┘
```

- **One process, no database.** State lives in `DATA_DIR` on a persistent volume.
- **Full reconciliation every run.** Each run compares all of BambooHR with all of Google, so a failed or missed run fixes itself on the next one.
- **Run as a single instance.** The run lock is in-process.

## Prerequisites

| You need | Why |
|---|---|
| Node.js **22.9+**, or Docker | Runtime |
| A BambooHR user who can see every employee | Owns the API key |
| A Google Workspace **super admin** | Authorizes delegation, and the sync acts as this user |
| A Google Cloud project (any) | Hosts the service account |
| *Optional:* `gcloud` CLI, `jq` | Faster setup with the commands below |

## 1. BambooHR API key

1. In BambooHR, click your avatar and go to **API Keys → Add New Key**. The key inherits that user's permissions, so use a user with access to every employee and every field you sync.
2. Your **subdomain** is the part before `.bamboohr.com`.
3. Check the key works:

   ```sh
   export BAMBOO_SUBDOMAIN=yourcompany BAMBOO_API_KEY=xxxxxxxx
   curl -s -u "$BAMBOO_API_KEY:x" -H "Accept: application/json" \
     "https://api.bamboohr.com/api/gateway.php/$BAMBOO_SUBDOMAIN/v1/meta/fields" | jq length
   ```

   A number means the key works. A `401` means the key is wrong; a `403` means the user lacks permissions.

The sync reads these fields: `id, status, workEmail, homeEmail, firstName, preferredName, lastName, jobTitle, department, division, employmentHistoryStatus, supervisorEmail, hireDate, country`, plus any fields you map to Google custom attributes.

## 2. Google Cloud service account

With `gcloud`:

```sh
PROJECT=your-project-id
gcloud config set project "$PROJECT"
gcloud services enable admin.googleapis.com licensing.googleapis.com

gcloud iam service-accounts create directory-sync --display-name "Directory Sync"
gcloud iam service-accounts keys create key.json \
  --iam-account "directory-sync@$PROJECT.iam.gserviceaccount.com"

jq -r .client_id key.json     # the numeric client ID you need in step 3
```

Or in the Cloud console:

1. Under **APIs & Services → Library**, enable the **Admin SDK API** and the **Enterprise License Manager API**.
2. Under **IAM & Admin → Service accounts**, create a service account. It needs no Cloud IAM roles; it gets its access through delegation.
3. Open the service account, go to **Keys → Add key → JSON**, and download the file.
4. Copy the **client ID**, the `client_id` value in the JSON file. It's a long number, not the email address.

> If key creation is blocked, your organization enforces the `iam.disableServiceAccountKeyCreation` policy. An org admin has to allow it for this project.

Treat `key.json` like a password. You'll upload it in the console in step 5 and can then delete the local copy.

## 3. Domain-wide delegation

Delegation lets the service account act as one of your admins.

1. Go to [admin.google.com](https://admin.google.com) → **Security → Access and data control → API controls → Manage Domain Wide Delegation → Add new**.
2. Paste the **client ID** from step 2.
3. Paste these **OAuth scopes** as one comma-separated line:

   ```
   https://www.googleapis.com/auth/admin.directory.user,https://www.googleapis.com/auth/admin.directory.group,https://www.googleapis.com/auth/admin.directory.group.member,https://www.googleapis.com/auth/apps.licensing
   ```

   | Scope | Used for |
   |---|---|
   | `admin.directory.user` | List, create, update and suspend users |
   | `admin.directory.group` | List a leaver's groups |
   | `admin.directory.group.member` | Remove a leaver from groups |
   | `apps.licensing` | Revoke licences from leavers |

   All four must be listed. If one is missing, Google rejects every token request with `unauthorized_client`.

4. Choose the admin the sync acts as (`GOOGLE_ADMIN`). It must be a **super admin** in this Workspace and use its **primary** email address. A custom admin role also works if it has user, group and licence management privileges.

New or changed delegation can take from a few minutes to a few hours to take effect.

## 4. Deploy

Pick one. Every option needs **persistent storage for `DATA_DIR`** and, if it's reachable from outside your network, **HTTPS**.

### Docker

```sh
export ENCRYPTION_KEY="$(openssl rand -base64 32)"   # save this value in your password manager
docker build -t bamboohr-gws-sync .
docker run -d --name directory-sync --restart unless-stopped \
  -p 3000:3000 -v directory-sync-data:/data \
  -e TZ=Europe/Berlin -e ENCRYPTION_KEY \
  bamboohr-gws-sync
```

Keep the same `ENCRYPTION_KEY` on every restart and store it somewhere safe (see [Security](../README.md#security)). If you lose it, you have to re-enter the credentials in the console.

### Docker Compose

```yaml
services:
  directory-sync:
    build: .
    restart: unless-stopped
    ports: ["3000:3000"]
    environment:
      TZ: Europe/Berlin
      ENCRYPTION_KEY: ${ENCRYPTION_KEY}   # from your shell or a .env next to this file
    volumes: ["data:/data"]
volumes:
  data:
```

### Node directly (for example a VM or a Raspberry Pi)

```sh
git clone <this repo> && cd bamboohr-gws-sync
npm ci && npm run build
DATA_DIR=/var/lib/directory-sync PORT=3000 npm start
```

A systemd unit keeps it running:

```ini
# /etc/systemd/system/directory-sync.service
[Unit]
Description=BambooHR to Google Workspace sync
After=network-online.target

[Service]
WorkingDirectory=/opt/bamboohr-gws-sync
ExecStart=/usr/bin/node dist/server.js
Environment=DATA_DIR=/var/lib/directory-sync PORT=3000 TZ=Europe/Berlin
EnvironmentFile=-/etc/directory-sync.env
User=directory-sync
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### HTTPS in front

The console uses HTTP basic auth, so it must sit behind TLS when exposed. With [Caddy](https://caddyserver.com), this is the whole config, and it gets a certificate automatically:

```
sync.example.com {
  reverse_proxy localhost:3000
}
```

### Headless, without the console

To run only from cron or a Kubernetes CronJob, set the credentials as environment variables (see `.env.example`) and run the CLI. It exits non-zero when anything fails.

```sh
npm run sync               # dry run
npm run sync -- --apply    # apply
# Docker: docker run --rm --env-file .env -v directory-sync-data:/data bamboohr-gws-sync node dist/cli.js --apply
```

## 5. First run in the console

1. Open the console. The first visit asks you to **create the admin password**; you then sign in as `admin` (change with `UI_USER`). Do this right after deploying, or set `UI_PASSWORD` up front, because until a password exists anyone who reaches the URL can set it.
2. Go to **Connections → Credentials** and enter:
   - BambooHR subdomain and API key
   - Google super admin
   - the service account **JSON key** (upload the file)
   - *optional:* Slack webhook

   Values are encrypted on disk and never shown again. The card also shows the client ID and scope list from step 3, ready to copy.
3. Press **Test again**. Both APIs should show `ok`. If not, see [Troubleshooting](#troubleshooting).

Prefer a secret manager? Set the same values as environment variables instead. They take precedence and appear as *env var* in the console.

## 6. Configure the sync

Everything is under **Settings** and starts empty or neutral.

| Setting | What it does | Typical value |
|---|---|---|
| OU for new users | Where creates land | `/` or `/Staff` |
| OU for suspended users | Where leavers are moved (blank keeps their OU) | `/Suspended` |
| Protected OUs | Users here are never suspended, and suspended users here are never touched | `/Service accounts` |
| Managed domains | Only create users in these domains. Blank means domains your Workspace already uses. | `example.com` |
| Recovery inbox | Leavers get `inbox+first.last@` as recovery email | a shared IT inbox |
| Licence product / SKUs | Licences revoked from leavers ([product and SKU IDs](https://developers.google.com/admin-sdk/licensing/v1/how-tos/products)) | `Google-Apps` / your SKU |
| Custom field mapping | BambooHR fields copied into Google custom attributes | see the [README](../README.md#optional-sync-extra-fields-into-google-custom-attributes) |
| Max suspensions per run | Above this, **all** suspensions in a run are blocked | `10` |
| Suspend users deleted in BambooHR | Linked Google users without an employee record are suspended | on |
| Reactivate suspended users | Rehires are unsuspended | off |
| Schedule | Cron expression, in the server's `TZ`. Blank = off. | `0 2 * * *` |
| Scheduled runs are previews | Scheduled runs only plan | on for the first days |

## 7. Roll out safely

1. **Preview the whole directory** (Overview → *Preview changes*). Read every create and suspend. Nothing changes in Google.
2. **Apply one person** with *Employee lookup* (or `npm run sync -- --employee <id> --apply`). Check them in the Admin console.
3. **Apply everything** once the preview is what you expect. The first run mostly links existing users: they're matched by email, and the BambooHR id is stamped on them as `externalIds[type=organization]`.
4. **Preview again.** It should show 0 changes. If it doesn't, something is fighting the sync, for example another tool editing the same fields.
5. **Turn on the schedule**, with *Scheduled runs are previews* on for a few days, then off.

## 8. Alerts

1. Create a Slack app with an [Incoming Webhook](https://api.slack.com/messaging/webhooks) for your alerts channel.
2. Paste the URL under Credentials, or set `SLACK_WEBHOOK_URL`.
3. Set `PUBLIC_URL` (Settings → Notifications) so alerts link to the run.
4. Press **Send test**.

By default you're alerted when a run fails, any action fails, or suspensions were blocked by the limit.

## Configuration reference

**Process and secrets** (environment only, or Credentials in the console where marked ✓):

| Variable | Console | Default | |
|---|---|---|---|
| `BAMBOO_SUBDOMAIN` | ✓ | | BambooHR subdomain |
| `BAMBOO_API_KEY` | ✓ | | BambooHR API key |
| `GOOGLE_ADMIN` | ✓ | | Super admin the service account acts as |
| `GOOGLE_CREDENTIALS` | ✓ | | Service account JSON, or a path to it |
| `SLACK_WEBHOOK_URL` | ✓ | | Slack Incoming Webhook |
| `BAMBOO_BASE_URL` | | gateway URL | Override the BambooHR API base |
| `INITIAL_PASSWORD` | | random per user | First password for new users (they must change it) |
| `UI_USER` / `UI_PASSWORD` | | `admin` / first-run | Console login |
| `ENCRYPTION_KEY` | | generated file | Key for credentials saved in the console |
| `PORT` | | `3000` | |
| `DATA_DIR` | | `./data` (`/data` in Docker) | Settings, encrypted credentials, run history |
| `TZ` | | system | Timezone for the schedule |

**Sync settings** can be set as environment variables for the first start; after that, Settings in the console wins: `APP_NAME, LOGO_URL, ACCENT_COLOR, SUPPORT_CONTACT, NEW_USER_OU, SUSPENDED_OU, PROTECTED_OUS, MANAGED_DOMAINS, RECOVERY_EMAIL, LICENSE_PRODUCT_ID, LICENSE_SKUS, CUSTOM_SCHEMA, CUSTOM_FIELDS, SUSPEND_MISSING, REACTIVATE_SUSPENDED, MAX_SUSPENSIONS_PER_RUN, CONCURRENCY, SYNC_SCHEDULE, SCHEDULE_DRY_RUN, NOTIFY_ON, PUBLIC_URL`. See `.env.example` for formats.

## Operations

- **Health check:** `GET /healthz` (no auth). The Docker image already uses it.
- **Logs:** one JSON line per event on stdout (run start and finish, and each action with its result).
- **Back up** `DATA_DIR` together with `ENCRYPTION_KEY`. Without the key, `secrets.enc.json` can't be read. Run history is capped at the last 200 runs.
- **Upgrade:** pull, rebuild and restart. Settings and credentials survive because they live in `DATA_DIR`.
- **Rotate a credential:** enter the new value under Credentials. It takes effect on the next request, with no restart.
- **Reset the console password:** set `UI_PASSWORD` and restart. The environment wins over the stored one.
- **Scale:** API usage is about 1 BambooHR call plus N/500 Google list calls per run, plus one write per changed user. Raise `CONCURRENCY` for large tenants.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `unauthorized_client` | Delegation missing, or a scope missing | Step 3: the client ID must be exact, with all 4 scopes. Wait a few minutes after changes. |
| Google `403 Not Authorized to access this resource/api` on **Test** | `GOOGLE_ADMIN` isn't a super admin, isn't the primary email, or is in another Workspace | Step 3.4 |
| Google `403` on **create** | The work email's domain isn't owned by your Workspace | Add the domain in Google, or fix the email in BambooHR. *Managed domains* controls which domains are allowed. |
| `404 Domain not found` on create | Typo in the work email's domain | Fix it in BambooHR |
| BambooHR `401` / `403` | Wrong key, or the key's user can't see employees or fields | Step 1 |
| BambooHR `503` | Rate limited | Retried automatically with backoff |
| "BambooHR returned no employees; refusing to sync" | Empty report (permissions or an outage) | Check the key user's access. This guard prevents mass suspension. |
| Suspensions show "Blocked: N suspensions exceed the limit" | More leavers than *Max suspensions per run* | Check they're real, then raise the limit for one run |
| A preview right after a live run shows the same change again | Google's user listing lags writes by 10–30 s | Preview again a minute later |
| "Saved credentials can't be decrypted" | `ENCRYPTION_KEY` changed or `secret.key` was lost | Restore the key, or re-enter the credentials |
| Can't log in | Wrong password, or the browser cached an old one | Set `UI_PASSWORD` and restart; try a private window |
