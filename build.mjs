// Bundles src/ into the mod folder mods/excalidraw (committed, so the repo is installable
// as is: herdr.dev and agents copy that folder) and, with --install, copies it to
// ~/.config/herdr-app/mods/excalidraw (or $HERDR_APP_HOME/mods/excalidraw).
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const root = new URL(".", import.meta.url).pathname;
const out = join(root, "mods", "excalidraw");
const appHome = process.env.HERDR_APP_HOME ?? join(homedir(), ".config", "herdr-app");

// roughjs (bundled inside @excalidraw/element) tokenizes SVG paths with the legacy
// RegExp.$1, which QuickJS does not have; rounded shapes then fail to draw. Swap that
// one function for an equivalent that reads match results.
const TOKENIZER = /function (\w+)\((\w)\)\{let (\w)=new Array;for\(;\2!=="";\)if\(\2\.match\(\/\^\(\[ \\t\\r\\n,\]\+\)\/\)\)[\s\S]*?else return\[\];return \3\[\3\.length\]=\{type:2,text:""\},\3\}/;
const tokenizer = (name) => `function ${name}(d){const t=[];const ws=/^[ \\t\\r\\n,]+/,cmd=/^[aAcChHlLmMqQsStTvVzZ]/,num=/^(?:[-+]?[0-9]+(?:\\.[0-9]*)?|[-+]?\\.[0-9]+)(?:[eE][-+]?[0-9]+)?/;while(d!==""){let m;if(m=ws.exec(d))d=d.slice(m[0].length);else if(m=cmd.exec(d)){t.push({type:0,text:m[0]});d=d.slice(m[0].length)}else if(m=num.exec(d)){t.push({type:1,text:\`\${parseFloat(m[0])}\`});d=d.slice(m[0].length)}else return[]}t.push({type:2,text:""});return t}`;
const patchRoughTokenizer = {
  name: "patch-rough-tokenizer",
  setup(b) {
    b.onLoad({ filter: /@excalidraw[\\/]element[\\/]dist[\\/]prod[\\/]index\.js$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const match = TOKENIZER.exec(source);
      if (!match) throw new Error("roughjs SVG tokenizer not found in @excalidraw/element; check the patch against this version");
      const contents = source.replace(TOKENIZER, tokenizer(match[1]));
      if (contents.includes("RegExp.$")) throw new Error("@excalidraw/element still uses RegExp.$ after patching");
      return { contents, loader: "js" };
    });
  },
};

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "fonts"), { recursive: true });

await build({
  entryPoints: [join(root, "src", "main.js")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["production"],
  // Provided by the Herdr host.
  external: ["gpui-kit", "gpui-base", "herdr", "buffer", "fs/promises"],
  // @excalidraw/element imports this subpath, but @excalidraw/math only exports it for types.
  alias: { "@excalidraw/math/ellipse": "@excalidraw/math" },
  // Browser globals the Excalidraw packages read while loading; see src/shim.js.
  banner: { js: await readFile(join(root, "src", "shim.js"), "utf8") },
  outfile: join(out, "main.js"),
  logLevel: "warning",
  plugins: [patchRoughTokenizer],
});

// No place in a layout. mod.open:excalidraw drops the launcher from the top like Herdr's own
// picker; it is as tall as its list, up to 70% of the window.
await writeFile(join(out, "mod.json"), JSON.stringify({ place: "none", title: "Excalidraw", overlay: { kind: "popup", at: "top", offset: 40, width: 560, height: 0.7 } }, null, 2) + "\n");
await cp(join(root, "node_modules", "excalifont", "fonts", "Excalifont-Regular.ttf"), join(out, "fonts", "Excalifont-Regular.ttf"));
await cp(join(root, "node_modules", "excalifont", "OFL.txt"), join(out, "fonts", "OFL.txt"));
// The bundle carries Excalidraw's code (and what @excalidraw/element bundles itself).
await cp(join(root, "LICENSE"), join(out, "LICENSE"));
await cp(join(root, "licenses", "excalidraw.txt"), join(out, "LICENSE-excalidraw.txt"));
// Toolbar icons, drawn by src/main.js as svg("mods/excalidraw/icons/<tool>.svg").
await cp(join(root, "src", "icons"), join(out, "icons"), { recursive: true });
console.log(`built ${out}`);

if (process.argv.includes("--install")) {
  const dest = join(appHome, "mods", "excalidraw");
  await mkdir(dest, { recursive: true });
  // Copy over the folder in place: Herdr hot-reloads the running copies, and keeps
  // the files it writes there itself (jsconfig.json, .d.ts).
  await cp(out, dest, { recursive: true, force: true });
  console.log(`installed ${dest}`);
}
