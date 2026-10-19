// build.ts bundles .md files with esbuild's text loader: the default export is
// the file's contents as a string.
declare module "*.md" {
  const text: string;
  export default text;
}
