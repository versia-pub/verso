/** The result of parsing a Versia JSON body: the value, or why it breaks the rules. */
export type JsonResult =
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly reason: string };

/**
 * Parses a request or response body under Versia's JSON rules. `JSON.parse` accepts more than
 * Versia does, and hides duplicate keys and escaped characters, so each string in the raw text is
 * checked as well. Number ranges are left to the schemas, since only `integer` fields have one.
 * @see https://versia.pub/json
 */
export const parseJson = (body: Uint8Array): JsonResult => {
    let text: string;
    let value: unknown;

    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(body);
        value = JSON.parse(text);
    } catch (error) {
        return { ok: false, reason: String(error) };
    }

    const reason = findViolation(text);
    return reason === undefined ? { ok: true, value } : { ok: false, reason };
};

/** Walks text that is already known to be valid JSON, checking its strings and keys. */
const findViolation = (text: string): string | undefined => {
    // One set of keys per open object, and null for each open array.
    const scopes: (Set<string> | null)[] = [];
    let i = 0;

    while (i < text.length) {
        const char = text[i];

        if (char === "{" || char === "[") {
            scopes.push(char === "{" ? new Set() : null);
            i++;
        } else if (char === "}" || char === "]") {
            scopes.pop();
            i++;
        } else if (char === '"') {
            const end = stringEnd(text, i);
            const string: string = JSON.parse(text.slice(i, end));
            const reason = stringViolation(string);
            if (reason !== undefined) {
                return reason;
            }

            // Inside an object, a string followed by a colon is a key.
            const keys = scopes.at(-1);
            let next = end;
            while (/\s/.test(text[next])) next++;
            if (keys && text[next] === ":") {
                if (string === "") {
                    return "Empty key";
                }
                if (keys.has(string)) {
                    return `Duplicate key ${JSON.stringify(string)}`;
                }
                keys.add(string);
            }

            i = end;
        } else {
            i++;
        }
    }

    return undefined;
};

/**
 * Checks a key or string value once its escapes are decoded, since `\r` and `\u000d` are the same
 * carriage return. I-JSON bans lone surrogates and noncharacters.
 * @see https://www.rfc-editor.org/rfc/rfc7493#section-2.1
 */
const stringViolation = (string: string): string | undefined => {
    if (string.includes("\r")) {
        return "Strings must not contain a carriage return";
    }
    if (!string.isWellFormed()) {
        return "Strings must not contain a lone surrogate";
    }
    if (/\p{Noncharacter_Code_Point}/u.test(string)) {
        return "Strings must not contain a noncharacter";
    }

    return undefined;
};

/** Returns the index just after the string that starts at `start`. */
const stringEnd = (text: string, start: number): number => {
    let i = start + 1;

    while (text[i] !== '"') {
        i += text[i] === "\\" ? 2 : 1;
    }

    return i + 1;
};
