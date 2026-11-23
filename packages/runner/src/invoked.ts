/** How this runner was started. It decides the command that texts name and the command line that a service runs. */
export type Invoked = {
    /** What a person types: `pi-pocket-runner`, or `pi-pocket runner` through Pi Pocket. */
    command: string;
    /** The words a service puts between the launcher and the runner's own words: none, or `runner`. */
    words: readonly string[];
    /** What `npm install -g` takes to get that command. */
    install: string;
};

/** Started by its own command. */
export const ALONE: Invoked = {
    command: "pi-pocket-runner",
    words: [],
    install: "pi-pocket-runner",
};
