import type { ToolRegistration } from "@earendil-works/pi-durable";
import { perf } from "../perf.ts";
import { RunnerEnv } from "./runners.ts";

/** Measure execution, not model time or the durable task's admission and settlement. */
export function timedTool(tool: ToolRegistration): ToolRegistration {
    const trace = perf;

    if (!trace || !["read", "edit", "write", "bash"].includes(tool.name)) {
        return tool;
    }

    return {
        ...tool,
        execute(args, api, context) {
            const start = trace.now();
            const fields = {
                tool: tool.name,
                conversation: Number(api.conversationId),
                call: api.callId,
                runner: api.env instanceof RunnerEnv ? api.env.link.id : undefined,
                firstOutputMs: undefined as number | undefined,
                resultError: undefined as boolean | undefined,
            };
            const measured = new Proxy(api, {
                get(target, property) {
                    if (property === "output") {
                        const output: typeof api.output = (chunk, skipped) => {
                            fields.firstOutputMs ??= trace.now() - start;
                            api.output(chunk, skipped);
                        };

                        return output;
                    }

                    return Reflect.get(target, property, target);
                },
            });

            return trace.operation("tool", fields, async () => {
                try {
                    const result = await tool.execute(args, measured, context);

                    fields.resultError = result.isError === true;

                    return result;
                } finally {
                    fields.firstOutputMs ??= trace.now() - start;
                }
            });
        },
    };
}
