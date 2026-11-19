# Privacy

The V5 Brain Simulator extension sends information to its maintainers, the UNSW Robotics Competition Club, in two ways: reports you send with **Report a Problem**, and automatic **error reports**. Nothing else leaves your computer. The simulator itself runs locally; the only other download is VEX's firmware (VEXos), from VEX.

## Report a Problem

Sent only when you press **Send** in the Report a Problem form. It contains:

- what you write: the kind of report, a summary, details, and, if you give it, a contact (an email or name);
- **if you tick "The V5 Sim log and my setup"** (on by default): the V5 Sim output log and your setup (extension, VS Code and OS versions, your `v5sim.*` settings). Your home folder and user name are taken out of both;
- **if you tick "My project folder"** (off by default): the files of the folder you choose, as listed in the form before you send. Version control (`.git`), build output, dependencies and files that may hold passwords or keys (`.env`, key files, `.vscode/settings.json` and similar) are left out; at most 10 MB.

With the report, the server records the time it arrived, the country it came from (not your IP address) and the extension's version.

**Where it goes.** Reports are stored privately on the maintainers' Cloudflare account (R2 storage). The summary, details, contact and setup also appear in the maintainers' Sentry project (EU region, Germany), so they are notified; attached files stay on Cloudflare and are reached from Sentry through links that stop working after 60 days.

If a report can't be sent (offline), you can save it as a zip and attach it to a GitHub issue yourself. GitHub issues are **public**; the saved zip leaves out your contact.

## Error reports

When the simulator fails to set up or start, or the extension hits an error, a short report goes to the maintainers' Sentry project (EU region). It contains:

- the error message (file paths taken out) and where in the extension it happened;
- the extension, VS Code and OS versions, the processor type, whether VS Code runs remotely (for example in WSL), and whether the bundled simulator or a developer's copy is in use;
- for a failed start, or the brain not reaching Windows USB, the last 40 lines of the V5 Sim log, with your home folder and user name taken out.

It never contains your code, your computer's name or your user name: these are taken out of the message and the log lines before anything is sent. Sentry is set not to store the IP address reports come from.

Error reports follow VS Code's telemetry setting: they are sent when **Telemetry: Telemetry Level** (`telemetry.telemetryLevel`) is `all` or `error`, and never when it is `crash` or `off`. Setting `v5sim.errorReporting` to `false` turns them off for this extension only.

## How long it is kept

- Reports on Cloudflare are deleted automatically after **180 days**.
- Sentry keeps error reports and the report copies for **30 days** (its free plan's retention), then deletes them.

## Who can see it

Only the extension's maintainers. Reports are never published and are used only to fix problems and improve the extension.

## Deleting your report

After sending, the form shows a reference (for example `2026-11-20/1a2b3c4d-…`). To have a report deleted before then, email the maintainers at [sim@unswrobotics.com](mailto:sim@unswrobotics.com) with that reference, or with the date and summary if you don't have it. It is deleted from Cloudflare and Sentry.
