import { parseArgs } from "node:util";
import { startSync } from "./sync.js";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    employee: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(`Usage: npm run sync -- [--apply] [--employee <bamboohr id>]

Without --apply the run is a dry run: it prints the plan and changes nothing.`);
  process.exit(0);
}

const run = await startSync({ dryRun: !values.apply, trigger: "cli", employeeId: values.employee }).done!;
for (const a of run.actions) {
  const detail = a.error ?? a.reason ?? a.diff?.map((d) => d.field).join(", ") ?? "";
  console.log(`${a.status.padEnd(8)} ${a.type.padEnd(8)} ${a.email.padEnd(40)} ${detail}`);
  for (const line of a.log ?? []) console.log(`${" ".repeat(18)}${line}`);
}
console.log(JSON.stringify({ status: run.status, counts: run.counts, error: run.error }));
process.exit(run.status === "success" ? 0 : 1);
