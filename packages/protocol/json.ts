/** The result of parsing a Versia JSON body: the value, or why it breaks the rules. */
export type JsonResult =
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly reason: string };

const keyPattern = /^[A-Za-z0-9\-_.#/:]+$/;
// Plain decimals only: no exponent, no leading zeros, and no trailing zeros after the point.
const numberPattern = /^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;

/**
 * Parses a request or response body under the rules at https://versia.pub/json. `JSON.parse`
 * accepts more than Versia does, and hides duplicate keys and how numbers were written, so the
 * raw text is scanned as well.
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
    if (text.includes("\r")) {
        return { ok: false, reason: "Line endings must be LF, not CRLF" };
    }
    const reason = findViolation(text);
    return reason === undefined ? { ok: true, value } : { ok: false, reason };
};

/** Walks text that is already known to be valid JSON, checking keys and numbers. */
const findViolation = (text: string): string | undefined => {
    // One set of keys per open object, and null for each open array.
    const scopes: (Set<string> | null)[] = [];
    // Sticky, so it matches at lastIndex without copying the rest of the text for each number.
    const numberToken = /-?[0-9.eE+-]+/y;
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
            const keys = scopes.at(-1);
            // Inside an object, a string followed by a colon is a key.
            let next = end;
            while (/\s/.test(text[next])) next++;
            if (keys && text[next] === ":") {
                const key: string = JSON.parse(text.slice(i, end));
                if (!keyPattern.test(key)) {
                    return `Invalid key ${JSON.stringify(key)}`;
                }
                if (keys.has(key)) {
                    return `Duplicate key ${JSON.stringify(key)}`;
                }
                keys.add(key);
            }
            i = end;
        } else if (char === "-" || (char >= "0" && char <= "9")) {
            numberToken.lastIndex = i;
            const raw = numberToken.exec(text)?.[0] ?? char;
            if (!numberPattern.test(raw) || raw === "-0" || outsideRange(raw)) {
                return `Invalid number ${raw}`;
            }
            i += raw.length;
        } else {
            i++;
        }
    }
    return undefined;
};

/** Whether a plain decimal lies outside -2⁵³ to 2⁵³. Compared exactly, since `Number()` rounds. */
const outsideRange = (raw: string): boolean => {
    const [whole, fraction] = raw.replace("-", "").split(".");
    const magnitude = BigInt(whole);
    const limit = 2n ** 53n;
    return magnitude > limit || (magnitude === limit && fraction !== undefined);
};

/** Returns the index just after the string that starts at `start`. */
const stringEnd = (text: string, start: number): number => {
    let i = start + 1;
    while (text[i] !== '"') {
        i += text[i] === "\\" ? 2 : 1;
    }
    return i + 1;
};
