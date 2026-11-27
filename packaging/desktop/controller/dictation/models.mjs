import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LIMIT = 2 * 1024 ** 3;

export const ENGINE_MODEL_LIMIT = 700_000_000;

// A model becomes installed only after every pin verifies. Removing a model never deletes another model's files.
export class SpeechModels {
    constructor(folder, extension) {
        this.root = join(folder, "speech-models-v1");
        this.extension = extension;
        this.selected = null;
        this.installed = [];
    }

    async open() {
        await mkdir(this.root, { recursive: true, mode: 0o700 });

        if (!(await lstat(this.root)).isDirectory()) {
            throw new Error("Invalid speech model folder");
        }

        const entries = await readdir(this.root, { withFileTypes: true });
        const stage = /^partial-[\da-f-]{36}$/;

        for (const entry of entries) {
            if (stage.test(entry.name)) {
                await rm(join(this.root, entry.name), { recursive: true, force: true });
            } else if (entry.isDirectory() && this.extension.modelById(entry.name)) {
                this.installed.push(entry.name);
            }
        }

        const saved = await this.#selection();

        this.selected = this.installed.includes(saved) ? saved : (this.installed[0] ?? null);
    }

    async #selection() {
        const path = join(this.root, "selected");
        const info = await lstat(path).catch(() => null);

        return info?.isFile() && info.size <= 64 ? readFile(path, "utf8") : null;
    }

    async select(id) {
        const next = join(this.root, `partial-${randomUUID()}`);

        try {
            await writeFile(next, id ?? "", { flag: "wx", mode: 0o600 });
            await rename(next, join(this.root, "selected"));
            this.selected = id;
        } finally {
            await rm(next, { force: true }).catch(() => {});
        }
    }

    async install(model, signal, progress) {
        if (this.installed.includes(model.id)) {
            return;
        }

        const { modelById, modelSize, ModelCache } = this.extension;
        const total = modelSize(model);
        const used = this.installed.reduce((bytes, id) => bytes + modelSize(modelById(id)), 0);
        const fs = await statfs(this.root);

        if (total > ENGINE_MODEL_LIMIT || total + used > LIMIT || fs.bavail * fs.bsize < total) {
            throw new Error(
                "Not enough space, or the model is too large. Remove an unused model or choose a smaller one.",
            );
        }

        const stage = join(this.root, `partial-${randomUUID()}`);
        const cache = new ModelCache(stage, { limit: total });
        let written = 0;

        try {
            progress(written, total);

            for (const file of model.files) {
                await cache.withFile(file, signal, async () => {
                    written += file.size;
                    progress(written, total);
                });
            }

            signal.throwIfAborted();
            await rename(stage, join(this.root, model.id));
            this.installed.push(model.id);

            if (!this.selected) {
                await this.select(model.id);
            }
        } finally {
            await rm(stage, { recursive: true, force: true }).catch(() => {});
        }
    }

    async remove(id) {
        await rm(join(this.root, id), { recursive: true, force: true });
        this.installed = this.installed.filter((item) => item !== id);

        if (id === this.selected) {
            const next = this.installed[0] ?? null;

            this.selected = next;
            await this.select(next);
        }
    }

    folder(id) {
        return join(this.root, id);
    }
}
