import { NodeSSH } from "node-ssh";
import * as path from 'path';
import * as fs from "fs";
import * as os from "os";
import * as util from "util";
import { drive_v3, google } from "googleapis";
import isOnline from "is-online";

// ------------------These should be updated------------------ //
const kRobotNetworkBaseIp = "10.16.48";
const kLogFolderId = "1dLI2PBtz-6NQLCZ2zNC5-zbqWt_5onbg";
// ----------------------------------------------------------- //

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