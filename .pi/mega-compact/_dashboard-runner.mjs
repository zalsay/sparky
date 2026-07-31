import { appendFileSync } from "node:fs";
const __log = "/Volumes/RC500/dev/claude-monitor/.pi/mega-compact/_dashboard-launch.log";
function __fail(err) {
  const msg = "[mega-compact] dashboard failed: " + (err && err.stack ? err.stack : String(err));
  try { appendFileSync(__log, msg + "\n"); } catch { /* ignore */ }
  console.error(msg);
  process.exit(1);
}
import { launchDashboardServer } from "/Users/yingzhang/.pi/agent/npm/node_modules/pi-mega-compact/dist/extensions/dashboard-server.js";
launchDashboardServer("/Volumes/RC500/dev/claude-monitor/.pi/mega-compact").catch(__fail);