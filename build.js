const esbuild = require("esbuild");
const { minify } = require("html-minifier-terser");
const fse = require("fs-extra");
const fs = require("fs");
const path = require("path");

const srcDir = "src";
const outDir = path.join("build");

fse.emptyDirSync(outDir);

// Minify all .js files
const jsFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith(".js"));
for (const file of jsFiles) {
  esbuild.buildSync({
    entryPoints: [path.join(srcDir, file)],
    bundle: false,
    minify: true,
    outfile: path.join(outDir, file),
  });
}

// Minify all .css files
const cssFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith(".css"));
for (const file of cssFiles) {
  esbuild.buildSync({
    entryPoints: [path.join(srcDir, file)],
    bundle: false,
    minify: true,
    outfile: path.join(outDir, file),
  });
}

// Minify popup.html
const htmlPath = path.join(srcDir, "popup.html");
if (fs.existsSync(htmlPath)) {
  const html = fs.readFileSync(htmlPath, "utf8");
  minify(html, {
    collapseWhitespace: true,
    removeComments: true,
    minifyJS: true,
    minifyCSS: true,
  }).then((minified) => {
    fs.writeFileSync(path.join(outDir, "popup.html"), minified);
  });
}

fse.copyFileSync(`src/manifest.json`, path.join(outDir, "manifest.json"));
fse.copySync(path.join(srcDir, "icons"), path.join(outDir, "icons"));

console.log(`✅ Built`);
