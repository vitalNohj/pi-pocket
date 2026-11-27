import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

// Callers pass fixed event names and codes. Do not log page addresses, request bodies, or exception messages here.
export function diagnostics(folder) {
    const file = join(folder, "diagnostics.log");
    let pending = Promise.resolve();

    return (event, code = "ok") => {
        if (!/^[a-z.-]{1,48}$/.test(event) || !/^[a-z.-]{1,48}$/.test(code)) {
            return;
        }

        pending = pending
            .then(async () => {
                await mkdir(dirname(file), { recursive: true, mode: 0o700 });

                if ((await stat(file).catch(() => null))?.size >= 1024 * 1024) {
                    await rename(file, join(folder, "diagnostics.old.log"));
                }

                await appendFile(file, `${new Date().toISOString()} ${event}: ${code}\n`, {
                    mode: 0o600,
                });
            })
            .catch(() => {});
    };
}
