/**
 * Role id by name, for a server that sends no `role_ids`: its user
 * names one role and nothing else.
 *
 * A leaf on purpose. Mention matching (lib/mentions.ts, in the startup chunk)
 * needs the answer, but it sits below the stores and must not import the
 * roster, and any module that imports the stores' code from here would change
 * how the bundler splits them. The channels store registers the lookup when it
 * loads, so this holds no state of its own beyond the function.
 */

let lookup: (name: string) => number | undefined = () => undefined;

/** Register how a role name is resolved to an id. */
export function registerRoleIdLookup(next: (name: string) => number | undefined): void {
  lookup = next;
}

/** The id of the role called `name`, or undefined when none is known. */
export function roleIdByName(name: string): number | undefined {
  return lookup(name);
}
