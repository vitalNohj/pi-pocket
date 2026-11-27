import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { installerName } from "../../packaging/desktop/feed/desktop-builds.mjs";

// The shipped app cannot select this feed. Tests inject the request function directly into the controller.
export async function updateFixture(platform, version, bytes) {
    const repo = "/repos/vitalNohj/pi-pocket";
    const query = "branch=desktop-native&event=push&status=success&per_page=1";
    const run = {
        id: 456,
        run_number: Number(version.split(".").at(-1)),
        head_branch: "desktop-native",
        head_repository: { full_name: "vitalNohj/pi-pocket" },
        event: "push",
        conclusion: "success",
    };
    const artifact = {
        id: 789,
        name: installerName(platform, version),
        size_in_bytes: bytes.length,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        expired: false,
        archive_download_url: "https://untrusted.invalid/installer",
    };
    const server = createServer((req, res) => {
        switch (req.url) {
            case `${repo}/actions/workflows/desktop-builds.yml/runs?${query}`:
                res.end(JSON.stringify({ workflow_runs: [run] }));
                break;
            case `${repo}/actions/runs/456/artifacts?per_page=100`:
                res.end(JSON.stringify({ artifacts: [artifact] }));
                break;
            case "/installer":
                res.end(bytes);
                break;
            default:
                res.writeHead(404).end();
                break;
        }
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}`;

    return {
        run,
        artifact,
        url,
        close: () => server.close(),
        async request(path) {
            const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(5000) });

            if (!response.ok) {
                throw new Error(`Unexpected fixture request: ${path}`);
            }

            return response.json();
        },
    };
}
