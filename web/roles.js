// What a person is, as the server said it. The page compares no role itself: wherever the server names a person (who is
// signed in, the people list, a computer's people, a session's people, who is here), it says the role for its words,
// and beside it the answers below (`src/server/roles.ts` `roleSaid`, asked of the access policy). So a new role, or a
// new rule for one, is decided on the server alone, and the page cannot disagree with it. `test/role-boundary.test.ts`
// holds that line: no file of the page compares a role with "owner", "guest", or "viewer".
//
// Each takes a person as the server said them, or nothing (nobody is signed in yet, or the person is not known).

/** Is this the owner. */
export const isOwner = (person) => person?.owner === true;

/** Is this a viewer: they read, chat, and react, and never steer Pi. Not so for someone not known. */
export const isViewer = (person) => person?.prompts === false;

/** Does this person prompt: the owner, and a user. Not so for someone not known. */
export const prompts = (person) => person?.prompts === true;

/** Is this a user: they prompt, and are not the owner. */
export const isUser = (person) => prompts(person) && !isOwner(person);
