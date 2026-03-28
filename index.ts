import { NodeSSH } from "node-ssh";
import * as path from 'path';
import * as fs from "fs";
import * as os from "os";

const ssh = new NodeSSH;

const kRobotNetworkBaseIp = "10.16.48";
const kRioIp = kRobotNetworkBaseIp + ".2";

const logFileRegex = /^akit_[^_]+_[^_]+_[^_]+_[qe]\d+.wpilog$/;

let robotConnected = false;

setInterval(() => {
    const recentPoll = isRobotNetworkConnected();

    if (recentPoll !== robotConnected && recentPoll) {
        console.log("Found robot network!! Downloading logs...");
        downloadLogs();
    }

    robotConnected = recentPoll;
}, 3000);

function isRobotNetworkConnected() {
    return Object.entries(os.networkInterfaces()).flatMap(e => e[1]).some(n => n?.address.includes(kRobotNetworkBaseIp));
};

async function downloadLogs() {
    await ssh.connect({
        host: kRioIp,
        username: "admin",
        password: ""
    })

    const sftp = await ssh.requestSFTP();

    sftp.readdir('/u/logs', (err, list) => {
        list = list.filter(i => logFileRegex.test(i.filename));

        for (const file of list) {
            const { filename } = file;
            const splitByUS = filename.split("_");
            const event = splitByUS[3];
            const match = splitByUS[4].split(".")[0];
            const matchType = match.substring(0, 1);
            const matchNumber = match.substring(1);
            const friendlyName = (matchType === "q" ? "Qual-" : "Elim-") + matchNumber;

            const localPath = path.join(__dirname, 'logs', event, `${friendlyName}.wpilog`);
            if (!fs.existsSync(localPath)) {
                fs.mkdirSync(path.dirname(localPath), { recursive: true });
                ssh.getFile(localPath, `/u/logs/${filename}`);
            }
        };

        ssh.dispose();
    });
}