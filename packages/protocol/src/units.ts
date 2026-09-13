/**
 * What a receipt may call the things it counts.
 *
 * A receipt gets 1024 bytes and no more, because the mirror REST API does not reassemble
 * chunked messages — so a key name is spent from the same budget as the sources list.
 *
 * That is why "name your own units" is capped rather than open. An unbounded schema does
 * not fail when the schema is designed; it fails when some adopter's sixth unit pushes a
 * receipt over the limit, which is after their buyer has paid. The caps move that failure
 * to a unit test, where a developer can act on it.
 *
 * The reserved names are the ones receipts already on the topic use. They are ordinary
 * names under this scheme — short, alphanumeric, four or fewer per receipt — which is the
 * whole reason v1 through v3 receipts remain valid without translation.
 */

export const MAX_UNITS = 4;
export const MAX_UNIT_NAME = 12;

/** Units that predate generic metering and keep their meaning and their rates. */
export const RESERVED_UNITS = ["steps", "pages", "sessionMs"] as const;

/** Artifacts that predate generic evidence. `finalUrl` is not here: it is not a hash. */
export const RESERVED_ARTIFACTS = ["pageHash", "screenshotHash"] as const;

const NAME = /^[a-zA-Z][a-zA-Z0-9]*$/;

export class UnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitError";
  }
}

/**
 * Throw unless every key is a cheap, legible name and every count is countable.
 *
 * `kind` is in the message rather than inferred, because "at most 4 units" and "at most 4
 * artifacts" are different problems with different fixes, and a caller staring at the
 * error needs to know which one they have.
 */
export function assertValidUnits(
  map: Record<string, number | string>,
  kind: "unit" | "artifact",
): void {
  const names = Object.keys(map);
  if (names.length > MAX_UNITS) {
    throw new UnitError(
      `a receipt carries at most ${MAX_UNITS} ${kind}s; got ${names.length} (${names.join(", ")})`,
    );
  }

  for (const name of names) {
    if (name.length > MAX_UNIT_NAME) {
      throw new UnitError(`${kind} name \`${name}\` is over ${MAX_UNIT_NAME} characters`);
    }
    if (!NAME.test(name)) {
      throw new UnitError(
        `${kind} name \`${name}\` must be letters and digits, starting with a letter`,
      );
    }

    // Only units are counted. An artifact's value is a hash, checked where hashes are.
    if (kind === "unit") {
      const value = map[name];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new UnitError(
          `${kind} \`${name}\` must be a non-negative whole number, got ${String(value)}`,
        );
      }
    }
  }
}
