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

                if (!logs.some(l => l.id === log.id && l.status.downloaded)) {
                    try {
                        fs.mkdirSync(path.dirname(log.locations.localPath), { recursive: true });
                        await ssh.getFile(log.locations.localPath, log.locations.rio.path);
                        // if (fs.existsSync(log.locations.localPath)) {
                        //     await ssh.execCommand("rm " + log.locations.rio.path);
                        // }
                        logs.push(log);
                    } catch (err) {
                        logWithTimestamp("Could not download log file: " + log.id)
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

        const fileId = await uploadFile(drive, log.locations.localPath, log.name + ".wpilog", folderId).catch(() => logWithTimestamp("Could not upload log: " + log.id));

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
}

const app = express();
const kServerPort = 3000;

// Serve the file browser UI
app.get("/", (_req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>FRC Log Browser</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0d1117; color: #e6edf3; font-family: 'Courier New', monospace; min-height: 100vh; padding: 32px; }
    .header { border-bottom: 1px solid #21262d; padding-bottom: 20px; margin-bottom: 28px; }
    .tag { font-size: 11px; color: #7d8590; letter-spacing: 0.12em; text-transform: uppercase; display: flex; align-items: center; gap: 8px; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #3fb950; display: inline-block; }
    h1 { font-size: 24px; color: #58a6ff; margin-top: 6px; letter-spacing: -0.02em; }
    .breadcrumb { font-size: 12px; color: #7d8590; margin-bottom: 20px; }
    .breadcrumb a { color: #58a6ff; text-decoration: none; }
    .breadcrumb a:hover { text-decoration: underline; }
    .grid { display: grid; gap: 8px; }
    .item { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: #161b22; border: 1px solid #21262d; border-radius: 6px; text-decoration: none; color: inherit; transition: border-color 0.15s; }
    .item:hover { border-color: #58a6ff; }
    .icon { font-size: 15px; width: 20px; text-align: center; flex-shrink: 0; }
    .name { font-size: 14px; }
    .meta { margin-left: auto; font-size: 11px; color: #7d8590; white-space: nowrap; padding-left: 12px; }
    .dl { background: #1f6feb; color: white; border: none; border-radius: 4px; padding: 4px 10px; font-size: 11px; cursor: pointer; font-family: inherit; text-decoration: none; flex-shrink: 0; margin-left: 8px; }
    .dl:hover { background: #388bfd; }
    .empty { color: #484f58; font-size: 13px; padding: 24px 0; }
  </style>
</head>
<body>
  <div class="header">
    <div class="tag"><span class="dot"></span> FRC Log Server</div>
    <h1>📁 Log Browser</h1>
  </div>
  <div id="breadcrumb" class="breadcrumb"></div>
  <div id="list" class="grid"></div>
  <script>
    async function load(event) {
      const res = await fetch('/files' + (event ? '?event=' + event : ''));
      const data = await res.json();
      const crumb = document.getElementById('breadcrumb');
      const list = document.getElementById('list');
      if (event) {
        crumb.innerHTML = '<a href="#" onclick="load();return false">logs</a> / ' + event;
      } else {
        crumb.textContent = 'logs';
      }
      if (data.length === 0) {
        list.innerHTML = '<div class="empty">No logs found yet.</div>';
        return;
      }
      list.innerHTML = data.map(item => {
        if (item.type === 'folder') {
          return \`<a class="item" href="#" onclick="load('\${item.name}');return false">
            <span class="icon">📁</span>
            <span class="name">\${item.name}</span>
            <span class="meta">\${item.count} file\${item.count !== 1 ? 's' : ''}</span>
          </a>\`;
        } else {
          return \`<div class="item">
            <span class="icon">📄</span>
            <span class="name">\${item.name}</span>
            <span class="meta">\${item.size}</span>
            <a class="dl" href="/download?event=\${item.event}&file=\${encodeURIComponent(item.name)}">↓ Download</a>
          </div>\`;
        }
      }).join('');
    }
    load();
  </script>
</body>
</html>`);
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
            const mb = (stat.size / 1024 / 1000).toFixed(1);
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