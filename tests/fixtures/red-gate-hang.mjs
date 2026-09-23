import { pathToFileURL } from "node:url";

const { runRedGate } = await import(pathToFileURL(process.env.RED_GATE_MODULE).href);

const task = JSON.parse(process.env.RED_GATE_TASK);
const cwd = process.env.RED_GATE_CWD;
const appDataDir = process.env.RED_GATE_APPDATA;

runRedGate({
  task,
  cwd,
  timeoutMs: 600000,
  appDataDir,
  runCmd: () => new Promise(() => {}),
}).catch(() => {});
