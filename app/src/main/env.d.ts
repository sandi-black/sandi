// electron-vite's `?asset` imports copy the file into the build output and
// resolve to its runtime path.
declare module "*.png?asset" {
  const path: string;
  export default path;
}
declare module "*.ico?asset" {
  const path: string;
  export default path;
}
