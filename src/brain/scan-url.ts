/**
 * Where the scan brain's grid is, next to the code: bundlers copy the file
 * and rewrite this URL, so it works from the site and from the package.
 */
export const SCAN_URL = new URL('../assets/brain-mni152.sdf.gz', import.meta.url).href;
