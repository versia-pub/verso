/**
 * Makes a Versia-branded banner for a README: the Versia logo, a title and a tagline. The text is
 * turned into paths, since GitHub shows an SVG as an image, which can't load fonts. Run it with
 * `nix run .#banner`, which provides Inkscape and the Inter font, or from another project with
 * `nix run github:versia-pub/verso#banner`.
 */

const usage =
    `Usage: banner --title <title> --tagline <tagline> [--theme light|dark] [--output <file>]

Writes the banner to <file>, or to banner.svg. The dark theme suits pages with a dark background;
a README can show each with a <picture> element and prefers-color-scheme.`;

const width = 1280;
const height = 400;

/** Where the text starts, right of the logo, and how far it may reach, as far from the edge. */
const textLeft = 352;
const textRight = width - 104;

/** The Versia logo, from https://cdn.versia.pub/branding/icon.svg, without its inner shadow. */
const logoTile =
    "M0 40C0 17.9086 17.9086 0 40 0H189C211.091 0 229 17.9086 229 40V189C229 211.091 211.091 229 189 229H40C17.9086 229 0 211.091 0 189V40Z";
const logoSparkles =
    "M87.6275 72.9378C86.938 72.6563 86.3111 72.2409 85.7832 71.7155C85.2554 71.1901 84.837 70.5652 84.5523 69.877L79.9756 59.4868C79.119 57.8361 76.655 57.8361 75.8465 59.4868L71.265 69.8818C70.6453 71.2386 69.5543 72.3244 68.1946 72.9378L62.3522 75.4595C61.9679 75.638 61.6426 75.9227 61.4146 76.2799C61.1867 76.6372 61.0655 77.0522 61.0655 77.4759C61.0655 77.8997 61.1867 78.3147 61.4146 78.6719C61.6426 79.0292 61.9679 79.3138 62.3522 79.4924L68.1946 82.0141C69.6047 82.5964 70.7115 83.7129 71.265 85.0749L75.8465 95.5132C76.7031 97.1639 79.1671 97.1639 79.9756 95.5132L84.5571 85.0701C85.1635 83.7129 86.2704 82.6446 87.6275 82.0141L93.4699 79.4924C93.8542 79.3138 94.1795 79.0292 94.4075 78.6719C94.6354 78.3147 94.7566 77.8997 94.7566 77.4759C94.7566 77.0522 94.6354 76.6372 94.4075 76.2799C94.1795 75.9227 93.8542 75.638 93.4699 75.4595L87.6275 72.9378ZM160.075 104.233C155.89 102.36 152.58 98.9556 150.825 94.7191L137.052 62.1481C136.489 60.9799 135.608 59.9942 134.509 59.3044C133.411 58.6145 132.141 58.2486 130.844 58.2486C129.547 58.2486 128.276 58.6145 127.178 59.3044C126.08 59.9942 125.199 60.9799 124.636 62.1481L110.857 94.7191C109.075 98.9359 105.776 102.331 101.613 104.233L84.1817 112.126C79.0227 114.677 79.0227 122.136 84.1817 124.687L101.613 132.579C105.795 134.457 109.103 137.86 110.862 142.093L124.636 174.664C125.199 175.833 126.08 176.818 127.178 177.508C128.276 178.198 129.547 178.564 130.844 178.564C132.141 178.564 133.411 178.198 134.509 177.508C135.608 176.818 136.489 175.833 137.052 174.664L150.83 142.093C152.612 137.877 155.911 134.482 160.075 132.579L177.506 124.687C182.665 122.136 182.665 114.677 177.506 112.126L160.075 104.233ZM76.8523 136.838C77.6223 138.725 79.0372 140.188 80.8082 141.035L88.2675 144.524C88.772 144.786 89.1948 145.182 89.4898 145.668C89.7848 146.155 89.9408 146.713 89.9408 147.281C89.9408 147.85 89.7848 148.408 89.4898 148.894C89.1948 149.38 88.772 149.776 88.2675 150.039L80.8082 153.528C79.0372 154.375 77.6271 155.886 76.8523 157.724L70.9426 172.051C70.7066 172.558 70.3307 172.987 69.8593 173.288C69.3878 173.588 68.8403 173.748 68.2812 173.748C67.7221 173.748 67.1747 173.588 66.7032 173.288C66.2317 172.987 65.8559 172.558 65.6199 172.051L59.715 157.724C58.9649 155.882 57.5543 154.385 55.7591 153.528L48.2997 150.039C47.7953 149.776 47.3725 149.38 47.0775 148.894C46.7825 148.408 46.6265 147.85 46.6265 147.281C46.6265 146.713 46.7825 146.155 47.0775 145.668C47.3725 145.182 47.7953 144.786 48.2997 144.524L55.7591 141.035C57.5301 140.188 58.9402 138.677 59.715 136.838L65.6247 122.511C65.8607 122.004 66.2366 121.576 66.708 121.275C67.1795 120.974 67.7269 120.815 68.2861 120.815C68.8452 120.815 69.3926 120.974 69.8641 121.275C70.3355 121.576 70.7114 122.004 70.9474 122.511L76.8523 136.838Z";

/** A four-pointed sparkle, 2 wide, drawn around 0,0. */
const sparkle =
    "M0 -1C0.08 -0.3 0.3 -0.08 1 0C0.3 0.08 0.08 0.3 0 1C-0.08 0.3 -0.3 0.08 -1 0C-0.3 -0.08 -0.08 -0.3 0 -1Z";

type Theme = {
    readonly background: string;
    readonly sparkle: string;
    readonly border: string;
    readonly title: string;
    readonly tagline: string;
};

/** The logo's tile is the same in both, as it is Versia's colour. */
const themes: Record<string, Theme> = {
    light: {
        background: "#F6EEFA",
        sparkle: "#EEDDF7",
        border: "#E6D4F0",
        title: "#22162B",
        tagline: "#6B5878",
    },
    dark: {
        background: "#1B1421",
        sparkle: "#251B2D",
        border: "#33263D",
        title: "#F4ECF8",
        tagline: "#B9A5C6",
    },
};

type Line = {
    readonly id: string;
    readonly text: string;
    readonly x: number;
    readonly y: number;
    readonly size: number;
    readonly weight: number;
    readonly spacing: number;
    readonly fill: string;
};

const parseArgs = (args: string[]): Map<string, string> | undefined => {
    const options = new Map<string, string>();

    for (let i = 0; i < args.length; i += 2) {
        const [name, value] = [args[i], args[i + 1]];
        if (!name.startsWith("--") || value === undefined) return undefined;
        options.set(name.slice(2), value);
    }

    return options;
};

const escapeXml = (text: string): string =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");

const inkscape = async (...args: string[]): Promise<string> => {
    const output = await new Deno.Command("inkscape", { args, stderr: "piped" }).output();
    if (!output.success) {
        throw new Error(`Inkscape failed: ${new TextDecoder().decode(output.stderr)}`);
    }

    return new TextDecoder().decode(output.stdout);
};

/** An SVG with only the text, which Inkscape measures and turns into paths. */
const textSvg = (lines: Line[]): string => {
    const texts = lines.map((line) =>
        `<text id="${line.id}" x="${line.x}" y="${line.y}" font-family="Inter" ` +
        `font-weight="${line.weight}" font-size="${line.size}" letter-spacing="${line.spacing}">` +
        `${escapeXml(line.text)}</text>`
    );

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
        `${texts.join("")}</svg>`;
};

/** Each line's outline, shrunk around its start if it would reach past `textRight`. */
const outlines = async (lines: Line[], directory: string): Promise<Map<string, string>> => {
    const source = `${directory}/text.svg`;
    const outlined = `${directory}/outlined.svg`;
    await Deno.writeTextFile(source, textSvg(lines));

    // Each line of --query-all is "id,x,y,width,height".
    const widths = new Map<string, number>();
    for (const row of (await inkscape("--query-all", source)).trim().split("\n")) {
        const [id, x, , w] = row.split(",");
        widths.set(id, Number(x) + Number(w));
    }

    await inkscape("--export-text-to-path", "--export-plain-svg", "-o", outlined, source);
    const svg = await Deno.readTextFile(outlined);

    const paths = new Map<string, string>();
    for (const line of lines) {
        const d = svg.match(new RegExp(`<path\\s+d="([^"]*)"\\s+id="${line.id}"`))?.[1];
        if (d === undefined) throw new Error(`Inkscape didn't outline the ${line.id}`);

        const right = widths.get(line.id) ?? 0;
        const scale = Math.min(1, (textRight - line.x) / (right - line.x));
        const transform = scale < 1
            ? ` transform="translate(${line.x} ${line.y}) scale(${scale.toFixed(4)}) ` +
                `translate(${-line.x} ${-line.y})"`
            : "";
        paths.set(line.id, `<path fill="${line.fill}"${transform}\n        d="${d}" />`);
    }

    return paths;
};

// Laid out as `deno fmt` would, so a repository that formats SVG files can keep the output as is.
const banner = (
    title: string,
    tagline: string,
    theme: Theme,
    paths: Map<string, string>,
): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <title>${escapeXml(`${title}: ${tagline}`)}</title>
    <!-- Made with Verso's scripts/banner.ts. The tile is the Versia logo. The text is Inter. -->
    <defs>
        <clipPath id="card">
            <rect width="${width}" height="${height}" rx="24" />
        </clipPath>
        <path id="sparkle"
            d="${sparkle}" />
    </defs>
    <g clip-path="url(#card)">
        <rect width="${width}" height="${height}" fill="${theme.background}" />
        <use href="#sparkle" fill="${theme.sparkle}" transform="translate(1190 310) scale(250)" />
    </g>
    <rect x="0.5" y="0.5" width="${width - 1}" height="${
        height - 1
    }" rx="23.5" fill="none" stroke="${theme.border}" />
    <g transform="translate(104 100) scale(0.8734)">
        <path
            d="${logoTile}"
            fill="#E6A9FE" />
        <path
            d="${logoSparkles}"
            fill="#FFFFFF" />
    </g>
    ${paths.get("title")}
    ${paths.get("tagline")}
</svg>
`;

const options = parseArgs(Deno.args);
const title = options?.get("title");
const tagline = options?.get("tagline");
const theme = themes[options?.get("theme") ?? "light"];

if (Deno.args.includes("--help")) {
    // deno-lint-ignore no-console -- the usage is the command's output
    console.log(usage);
    Deno.exit(0);
}

if (title === undefined || tagline === undefined || theme === undefined) {
    // deno-lint-ignore no-console -- the usage is the command's output
    console.error(usage);
    Deno.exit(1);
}

const lines: Line[] = [
    {
        id: "title",
        text: title,
        x: textLeft,
        y: 218,
        size: 128,
        weight: 700,
        spacing: -4,
        fill: theme.title,
    },
    // Moved right a little, as the title's first letter has more space on its left than small text.
    {
        id: "tagline",
        text: tagline,
        x: textLeft + 5,
        y: 278,
        size: 32,
        weight: 400,
        spacing: 0,
        fill: theme.tagline,
    },
];

const directory = await Deno.makeTempDir();
try {
    const output = options?.get("output") ?? "banner.svg";
    await Deno.writeTextFile(
        output,
        banner(title, tagline, theme, await outlines(lines, directory)),
    );
} finally {
    await Deno.remove(directory, { recursive: true });
}
