import { NodeSSH } from "node-ssh";
import * as path from 'path';
import * as fs from "fs";
import * as os from "os";
import * as util from "util";
import { drive_v3, google } from "googleapis";
import isOnline from "is-online";
import express from "express";

/** 
 * Set this value according to the ip configurations in the wpilib docs without the ".2" in the ip:
 * https://docs.wpilib.org/en/stable/docs/networking/networking-introduction/ip-configurations.html
 * Example: "10.16.48" for 1648 or "10.2.54" for 254.
*/
const kRobotNetworkBaseIp = "10.16.48";


/**
 * Set this to the id of the google drive folder in which you wish the log files to be placed. This
 * can be attained from the folder's URL in google drive (in the [FOLDER ID HERE] location as seen) below:
 * https://drive.google.com/drive/u/0/folders/[FOLDER ID HERE]
 */
const kLogFolderId = "1dLI2PBtz-6NQLCZ2zNC5-zbqWt_5onbg";

// No values below this line need be changed.

const kRioIp = kRobotNetworkBaseIp + ".2";
const kLogFileRegex = /^akit_[^_]+_[^_]+_[^_]+_[qep]\d+\.wpilog$/;

const ssh = new NodeSSH;
const auth = new google.auth.GoogleAuth({
    keyFile: 'service-account-key.json',
    scopes: ['https://www.googleapis.com/auth/drive'],
});

let robotConnected = false;
let driveUpdating = false;

// Live state surfaced by the status endpoint / dashboard.
let internetConnected = false;
let lastInternetCheck = 0;
let rioLogs: { id: string; name: string; filename: string; origin: string }[] = [];
let rioLogsCheckedAt: number | null = null;
let downloadingIds: string[] = [];
let uploadingId: string | null = null;
const activity: { time: string; message: string }[] = [];
const kStartedAt = Date.now();

type MatchType = "e" | "q" | "p"

type Log = {
    name: string;
    id: string;
    status: {
        downloaded: boolean;
        inDrive: boolean;
    }
    match: {
        event: string;
        type: MatchType;
        number: number;
    };
    locations: {
        localPath: string;
        rio: {
            path: string;
            origin: string;
        };
        drive?: {
            fileId: string;
            folderId: string;
        };
    }
}

function getPrefixFromMatchType(matchType: MatchType) {
    switch (matchType) {
        case "e":
            return "Elim-"
        case "q":
            return "Qual-"
        case "p":
            return "Prct-"
    }
}

if (!fs.existsSync("./logs.json")) {
    fs.writeFileSync("./logs.json", "[]");
}

const logs: Log[] = JSON.parse(fs.readFileSync("./logs.json").toString());

logWithTimestamp("Started!");

let running = false;
async function poll() {
    if (!running) {
        running = true;
        await logicLoop();
        running = false;
    }
    setTimeout(poll, 3000);
};
poll();

async function logicLoop() {
    const recentPoll = isRobotNetworkConnected();

    // Internet checks hit the network, so they run on a slower cadence than the poll.
    if (Date.now() - lastInternetCheck > 15000) {
        lastInternetCheck = Date.now();
        internetConnected = await isOnline().catch(() => false);
    }

    if (recentPoll !== robotConnected && recentPoll) {
        logWithTimestamp("Robot network found.");
        const res = await downloadLogs();
        if (!res) return;
    }

    if (recentPoll !== robotConnected && !recentPoll) {
        logWithTimestamp("Robot network lost.")
    }

    try {
        updateDrive();
    } catch (err) {
        logWithTimestamp("Could not update drive.");
    }

    robotConnected = recentPoll;
    fs.writeFileSync("./logs.json", JSON.stringify(logs));
};

function isRobotNetworkConnected() {
    return Object.entries(os.networkInterfaces()).flatMap(e => e[1]).some(n => n?.address.includes(kRobotNetworkBaseIp));
};

async function downloadLogs() {
    try {
        await ssh.connect({
            host: kRioIp,
            username: "admin",
            password: ""
        })
    } catch (err) {
        logWithTimestamp("Could not connect to robot: " + err);
        return false;
    };

    const foundOnRio: typeof rioLogs = [];

    try {
        const sftp = await ssh.requestSFTP();

        const readdirAsync = util.promisify(sftp.readdir.bind(sftp));

        for (const origin of ['/u/logs', '/home/lvuser/logs']) {

            const res = await readdirAsync(origin).catch(() => logWithTimestamp("Could not read dir: " + origin));
            if (!res) continue;

            const list = res.filter(i => kLogFileRegex.test(i.filename));

            for (const file of list) {
                const { filename } = file;
                const splitByUS = filename.split("_");
                const event = splitByUS[3];
                const match = splitByUS[4].split(".")[0];
                const matchType = match.substring(0, 1) as MatchType;
                const matchNumber = match.substring(1);
                const friendlyName = getPrefixFromMatchType(matchType) + matchNumber;

                const log: Log = {
                    name: friendlyName,
                    id: `${event}-${matchType}-${matchNumber}`,
                    status: {
                        downloaded: true,
                        inDrive: false
                    },
                    match: {
                        event,
                        type: matchType,
                        number: parseInt(matchNumber)
                    },
                    locations: {
                        localPath: path.join(__dirname, 'logs', event, `${friendlyName}.wpilog`),
                        rio: {
                            path: `${origin}/${filename}`,
                            origin
                        }
                    }
                }

                logWithTimestamp("Found log: " + log.name);

                foundOnRio.push({ id: log.id, name: log.name, filename, origin });

                if (!logs.some(l => l.id === log.id && l.status.downloaded)) {
                    downloadingIds.push(log.id);
                    try {
                        fs.mkdirSync(path.dirname(log.locations.localPath), { recursive: true });
                        await ssh.getFile(log.locations.localPath, log.locations.rio.path);
                        // if (fs.existsSync(log.locations.localPath)) {
                        //     await ssh.execCommand("rm " + log.locations.rio.path);
                        // }
                        logs.push(log);
                    } catch (err) {
                        logWithTimestamp("Could not download log file: " + log.id)
                    } finally {
                        downloadingIds = downloadingIds.filter(id => id !== log.id);
                    }
                }
            };
        }
    } catch (err) {
        logWithTimestamp("Uncaught error downloading logs: " + err);
        return false;
    } finally {
        ssh.dispose();
    }

    rioLogs = foundOnRio;
    rioLogsCheckedAt = Date.now();

    return true;
}

async function updateDrive() {
    if (driveUpdating) return;
    if (!logs.some(l => l.status.inDrive === false)) return;

    if (!await isOnline()) {
        logWithTimestamp("Computer must be online to upload to drive.");
        return;
    }

    driveUpdating = true;

    const drive = google.drive({ version: 'v3', auth });

    const folderData = (await drive.files.list({
        q: `'${kLogFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder'`,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
    })).data.files ?? [];
    const folders = folderData.map(f => ({ name: f.name, id: f.id }))

    for (let i = 0; i < logs.length; i++) {
        const log = logs[i];
        if (!log.status.downloaded || log.status.inDrive) continue;

        let folderId = folders.find(f => f.name === log.match.event)?.id;

        if (!folderId) {
            const file = await drive.files.create({
                supportsAllDrives: true,
                requestBody: {
                    name: log.match.event,
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: [kLogFolderId]
                },
                fields: 'id, name'
            });
            folderId = file.data.id;
        }

        if (!folderId) {
            logWithTimestamp("Could not find or create event folder: " + log.match.event);
            continue;
        }

        uploadingId = log.id;
        const fileId = await uploadFile(drive, log.locations.localPath, log.name + ".wpilog", folderId).catch(() => logWithTimestamp("Could not upload log: " + log.id));
        uploadingId = null;

        if (!fileId) continue;

        logs[i].locations.drive = {
            fileId,
            folderId
        }
        logs[i].status.inDrive = true;
        logWithTimestamp("Uploaded " + logs[i].name + " to the drive.")
    }

    driveUpdating = false;
}

async function uploadFile(drive: drive_v3.Drive, filePath: string, fileName: string, folderId: string) {
    // const fileSize = fs.statSync(filePath).size;

    const currentFiles = (await drive.files.list({
        q: `'${folderId}' in parents and name = '${fileName}' and trashed = false`,
        fields: 'files(id, name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
    })).data.files;

    if (currentFiles && currentFiles.length > 0) {
        return currentFiles[0].id;
    };

    const response = await drive.files.create(
        {
            supportsAllDrives: true,
            requestBody: {
                name: fileName,
                parents: [folderId]
            },
            media: {
                mimeType: "application/octet-stream",
                body: fs.createReadStream(filePath),
            },
            fields: 'id, name',
            uploadType: 'resumable',
        }
    );

    return response.data.id;
}

function logWithTimestamp(log: Object) {
    const date = new Date();
    const pn = (n: number) => n.toString().padStart(2, "0");
    const time = `${pn(date.getHours())}:${pn(date.getMinutes())}:${pn(date.getSeconds())}`;
    console.log(log + " (" + time + ")");

    activity.unshift({ time, message: String(log) });
    if (activity.length > 100) activity.length = 100;
}

const app = express();
const kServerPort = 3000;

// Serve the dashboard UI
app.get("/", (_req, res) => {
    res.send(kDashboardHtml);
});

const kDashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Pit Log Downloader</title>
  <style>
    :root {
      --bg: #f4f6f8; --card: #ffffff; --border: #d8dee4; --text: #1f2328; --muted: #656d76;
      --accent: #0969da; --green: #1a7f37; --green-bg: #dafbe1; --red: #cf222e; --red-bg: #ffebe9;
      --amber: #9a6700; --amber-bg: #fff8c5; --gray-bg: #eef1f4;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--bg); color: var(--text); min-height: 100vh; padding: 28px 16px 60px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 14px; line-height: 1.5;
    }
    .wrap { max-width: 1080px; margin: 0 auto; }
    header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 22px; }
    h1 { font-size: 24px; letter-spacing: -0.02em; }
    .sub { color: var(--muted); font-size: 13px; }
    h2 { font-size: 15px; margin-bottom: 10px; letter-spacing: -0.01em; }
    section { margin-top: 26px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; }
    .pad { padding: 14px 16px; }

    .status { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
    .status .card { display: flex; gap: 12px; align-items: flex-start; padding: 14px 16px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 5px; flex-shrink: 0; background: #8c959f; }
    .dot.ok { background: var(--green); } .dot.bad { background: var(--red); } .dot.busy { background: var(--amber); }
    .status .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
    .status .value { font-size: 16px; font-weight: 600; }
    .status .detail { font-size: 12px; color: var(--muted); word-break: break-all; }

    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
    .stat { text-align: center; padding: 14px 10px; }
    .stat .n { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }
    .stat .l { font-size: 12px; color: var(--muted); }

    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); padding: 10px 12px; border-bottom: 1px solid var(--border); font-weight: 600; }
    td { padding: 10px 12px; border-bottom: 1px solid #eceff2; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tbody tr:hover { background: #f8fafc; }
    .name { font-weight: 600; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }

    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
    .b-ok { background: var(--green-bg); color: var(--green); }
    .b-busy { background: var(--amber-bg); color: var(--amber); }
    .b-no { background: var(--gray-bg); color: var(--muted); }
    .b-bad { background: var(--red-bg); color: var(--red); }

    .btn { display: inline-block; background: var(--accent); color: #fff; border-radius: 6px; padding: 4px 10px; font-size: 12px; text-decoration: none; white-space: nowrap; }
    .btn:hover { background: #0860ca; }
    .btn.ghost { background: transparent; color: var(--accent); border: 1px solid var(--border); }
    .btn.ghost:hover { background: #f0f4f8; }

    .kv { display: grid; grid-template-columns: minmax(150px, 220px) 1fr; }
    .kv > div { padding: 9px 16px; border-bottom: 1px solid #eceff2; }
    .kv > div:nth-last-child(-n+2) { border-bottom: none; }
    .kv .k { color: var(--muted); font-size: 13px; }
    .kv .v { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; word-break: break-all; }

    .feed { max-height: 320px; overflow-y: auto; }
    .feed div { display: flex; gap: 12px; padding: 7px 16px; border-bottom: 1px solid #eceff2; font-size: 13px; }
    .feed div:last-child { border-bottom: none; }
    .feed .t { color: var(--muted); font-family: ui-monospace, Menlo, monospace; font-size: 12px; flex-shrink: 0; }
    .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start; }
    .empty { color: var(--muted); padding: 18px 16px; font-size: 13px; }
    a { color: var(--accent); }
    @media (max-width: 760px) { .cols { grid-template-columns: 1fr; } .hide-sm { display: none; } }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>Pit Log Downloader</h1>
        <div class="sub">Pulls match logs off the roboRIO and mirrors them to Google Drive.</div>
      </div>
      <div class="sub" id="updated">Loading…</div>
    </header>

    <div class="status" id="status"></div>

    <section>
      <div class="stats" id="stats"></div>
    </section>

    <section>
      <h2>Logs</h2>
      <div class="card" id="logs"></div>
    </section>

    <section class="cols">
      <div>
        <h2>On the robot</h2>
        <div class="card" id="rio"></div>
      </div>
      <div>
        <h2>Activity</h2>
        <div class="card feed" id="activity"></div>
      </div>
    </section>

    <section>
      <h2>Configuration</h2>
      <div class="card kv" id="config"></div>
    </section>
  </div>

  <script>
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const size = b => b == null ? '—' : b < 1024 * 1024 ? (b / 1024).toFixed(0) + ' KB' : (b / 1024 / 1024).toFixed(1) + ' MB';
    const ago = ts => {
      if (!ts) return 'never';
      const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.round(s / 60) + 'm ago';
      return Math.round(s / 3600) + 'h ago';
    };
    const badge = (cls, text) => '<span class="badge ' + cls + '">' + esc(text) + '</span>';

    function statusCard(label, ok, value, detail) {
      return '<div class="card"><span class="dot ' + ok + '"></span><div>' +
        '<div class="label">' + esc(label) + '</div>' +
        '<div class="value">' + esc(value) + '</div>' +
        '<div class="detail">' + esc(detail) + '</div>' +
        '</div></div>';
    }

    function render(d) {
      const c = d.connection, k = d.constants;

      const drive = c.driveUpdating
        ? { cls: 'busy', v: 'Uploading', d: c.uploadingId ? 'Current: ' + c.uploadingId : 'Syncing to Drive…' }
        : d.counts.pendingUpload > 0
          ? { cls: c.internet ? 'busy' : 'bad', v: d.counts.pendingUpload + ' waiting', d: c.internet ? 'Will upload on next pass' : 'Offline — cannot upload' }
          : { cls: 'ok', v: 'Up to date', d: 'All downloaded logs are in Drive' };

      document.getElementById('status').innerHTML = [
        statusCard('Robot network', c.robot ? 'ok' : 'bad', c.robot ? 'Connected' : 'Not connected',
          c.robot ? 'roboRIO at ' + k.kRioIp : 'Waiting for ' + k.kRobotNetworkBaseIp + '.x'),
        statusCard('Internet', c.internet ? 'ok' : 'bad', c.internet ? 'Online' : 'Offline',
          c.internet ? 'Drive uploads enabled' : 'Uploads paused until online'),
        statusCard('Downloading', c.downloadingIds.length ? 'busy' : 'ok',
          c.downloadingIds.length ? c.downloadingIds.length + ' in progress' : 'Idle',
          c.downloadingIds.length ? c.downloadingIds.join(', ') : 'Robot last scanned ' + ago(c.rioLogsCheckedAt)),
        statusCard('Google Drive', drive.cls, drive.v, drive.d)
      ].join('');

      document.getElementById('stats').innerHTML = [
        ['On robot', d.counts.onRobot], ['Known logs', d.counts.total], ['Downloaded', d.counts.downloaded],
        ['In Drive', d.counts.inDrive], ['Pending upload', d.counts.pendingUpload]
      ].map(s => '<div class="card stat"><div class="n">' + s[1] + '</div><div class="l">' + s[0] + '</div></div>').join('');

      const logsEl = document.getElementById('logs');
      if (!d.logs.length) {
        logsEl.innerHTML = '<div class="empty">No logs yet. Connect to the robot network and they will appear here.</div>';
      } else {
        const rows = d.logs.slice().sort((a, b) =>
          a.event === b.event ? b.matchNumber - a.matchNumber : a.event < b.event ? 1 : -1
        ).map(l => '<tr>' +
          '<td class="name">' + esc(l.name) + '</td>' +
          '<td class="hide-sm">' + esc(l.event) + '</td>' +
          '<td class="hide-sm">' + esc(l.matchType) + '</td>' +
          '<td class="mono">' + size(l.sizeBytes) + '</td>' +
          '<td>' + (l.onRobot ? badge('b-ok', 'On robot') : badge('b-no', 'Not on robot')) + '</td>' +
          '<td>' + (l.downloading ? badge('b-busy', 'Downloading…') : l.downloaded ? badge('b-ok', 'Local') : badge('b-bad', 'Missing')) + '</td>' +
          '<td>' + (l.uploading ? badge('b-busy', 'Uploading…') : l.inDrive ? badge('b-ok', 'In Drive') : badge('b-no', 'Pending')) + '</td>' +
          '<td style="text-align:right;white-space:nowrap">' +
            (l.downloaded ? '<a class="btn" href="/download?event=' + encodeURIComponent(l.event) + '&file=' + encodeURIComponent(l.localFile) + '">Download</a> ' : '') +
            '<button class="btn ghost" data-copy="' + esc(l.localPath) + '" title="' + esc(l.localPath) + '">Copy path</button> ' +
            (l.driveUrl ? '<a class="btn ghost" href="' + esc(l.driveUrl) + '" target="_blank" rel="noreferrer">Drive</a>' : '') +
          '</td></tr>').join('');
        logsEl.innerHTML = '<table><thead><tr><th>Match</th><th class="hide-sm">Event</th><th class="hide-sm">Type</th>' +
          '<th>Size</th><th>Robot</th><th>Local</th><th>Drive</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
      }

      const rioEl = document.getElementById('rio');
      if (!d.rioLogs.length) {
        rioEl.innerHTML = '<div class="empty">' +
          (c.robot ? 'No log files found on the roboRIO.' : 'Not connected — showing nothing from the last scan.') + '</div>';
      } else {
        rioEl.innerHTML = '<table><tbody>' + d.rioLogs.map(r => '<tr>' +
          '<td class="name">' + esc(r.name) + '</td>' +
          '<td class="mono">' + esc(r.origin) + '</td>' +
          '<td style="text-align:right">' + (r.downloaded ? badge('b-ok', 'Copied') : badge('b-busy', 'Not copied')) + '</td>' +
          '</tr>').join('') + '</tbody></table>';
      }

      document.getElementById('activity').innerHTML = d.activity.length
        ? d.activity.map(a => '<div><span class="t">' + esc(a.time) + '</span><span>' + esc(a.message) + '</span></div>').join('')
        : '<div class="empty">Nothing logged yet.</div>';

      const cfg = [
        ['Robot network base IP', k.kRobotNetworkBaseIp],
        ['roboRIO address', k.kRioIp],
        ['Drive folder ID', '<a href="' + esc(k.logFolderUrl) + '" target="_blank" rel="noreferrer">' + esc(k.kLogFolderId) + '</a>'],
        ['Server port', k.kServerPort],
        ['Poll interval', (k.pollIntervalMs / 1000) + 's'],
        ['Log file pattern', esc(k.kLogFileRegex)],
        ['roboRIO log dirs', k.rioLogDirs.map(esc).join('  ·  ')],
        ['Local log folder', esc(k.localLogsDir)],
        ['Server uptime', ago(d.startedAt).replace(' ago', '')]
      ];
      document.getElementById('config').innerHTML = cfg
        .map(r => '<div class="k">' + esc(r[0]) + '</div><div class="v">' + r[1] + '</div>').join('');

      document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString() + ' · refreshes every 3s';
    }

    async function tick() {
      try {
        render(await (await fetch('/status')).json());
      } catch (err) {
        document.getElementById('updated').textContent = 'Lost contact with the server…';
      }
    }
    tick();
    setInterval(tick, 3000);
  </script>
</body>
</html>`;

// Everything the dashboard renders, in one payload.
app.get("/status", (_req, res) => {
    const matchTypeNames: Record<MatchType, string> = { e: "Elimination", q: "Qualification", p: "Practice" };

    const decorated = logs.map(log => {
        let sizeBytes: number | null = null;
        try {
            sizeBytes = fs.statSync(log.locations.localPath).size;
        } catch { /* file was moved or deleted outside of this process */ }

        return {
            id: log.id,
            name: log.name,
            event: log.match.event,
            matchType: matchTypeNames[log.match.type],
            matchNumber: log.match.number,
            downloaded: log.status.downloaded,
            inDrive: log.status.inDrive,
            onRobot: rioLogs.some(r => r.id === log.id),
            downloading: downloadingIds.includes(log.id),
            uploading: uploadingId === log.id,
            localPath: log.locations.localPath,
            localFile: path.basename(log.locations.localPath),
            rioPath: log.locations.rio.path,
            sizeBytes,
            driveUrl: log.locations.drive ? `https://drive.google.com/file/d/${log.locations.drive.fileId}/view` : null
        };
    });

    res.json({
        now: Date.now(),
        startedAt: kStartedAt,
        connection: {
            robot: robotConnected,
            internet: internetConnected,
            driveUpdating,
            uploadingId,
            downloadingIds,
            rioLogsCheckedAt
        },
        constants: {
            kRobotNetworkBaseIp,
            kRioIp,
            kLogFolderId,
            logFolderUrl: `https://drive.google.com/drive/folders/${kLogFolderId}`,
            kServerPort,
            kLogFileRegex: kLogFileRegex.toString(),
            pollIntervalMs: 3000,
            rioLogDirs: ['/u/logs', '/home/lvuser/logs'],
            localLogsDir: path.join(__dirname, 'logs')
        },
        counts: {
            total: decorated.length,
            downloaded: decorated.filter(l => l.downloaded).length,
            inDrive: decorated.filter(l => l.inDrive).length,
            pendingUpload: decorated.filter(l => l.downloaded && !l.inDrive).length,
            onRobot: rioLogs.length
        },
        rioLogs: rioLogs.map(r => ({ ...r, downloaded: logs.some(l => l.id === r.id && l.status.downloaded) })),
        logs: decorated,
        activity
    });
});

// List events (folders) or files within an event
app.get("/files", (req, res) => {
    const logsDir = path.join(__dirname, 'logs');
    const event = req.query.event as string | undefined;

    if (!fs.existsSync(logsDir)) {
        return res.json([]);
    }

    if (!event) {
        // Return top-level event folders
        const entries = fs.readdirSync(logsDir, { withFileTypes: true })
            .filter(e => e.isDirectory())
            .map(e => {
                const files = fs.readdirSync(path.join(logsDir, e.name));
                return { type: 'folder', name: e.name, count: files.length };
            });
        return res.json(entries);
    }

    // Sanitize to prevent path traversal
    const eventDir = path.join(logsDir, path.basename(event));
    if (!fs.existsSync(eventDir)) {
        return res.json([]);
    }

    const files = fs.readdirSync(eventDir, { withFileTypes: true })
        .filter(e => e.isFile())
        .map(e => {
            const stat = fs.statSync(path.join(eventDir, e.name));
            const mb = (stat.size / 1024 / 1024).toFixed(1);
            return { type: 'file', name: e.name, event, size: `${mb} MB` };
        });

    res.json(files);
});

// Download a specific log file
app.get("/download", (req, res) => {
    const event = req.query.event as string;
    const file = req.query.file as string;

    if (!event || !file) {
        return res.status(400).send("Missing event or file parameter.");
    }

    // Sanitize both segments to prevent path traversal
    const filePath = path.join(__dirname, 'logs', path.basename(event), path.basename(file));

    if (!fs.existsSync(filePath)) {
        return res.status(404).send("File not found.");
    }

    res.download(filePath);
});

app.listen(kServerPort, () => {
    logWithTimestamp(`Log browser running at http://localhost:${kServerPort}`);
});