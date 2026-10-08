/**
 * The package's scan grid, inlined as a data URL: written as a plain string
 * rather than `new URL(..., import.meta.url)`, which other bundlers rewrite
 * into a path that does not exist.
 */
import url from '../assets/brain-mni152.sdf.gz?inline';

export const SCAN_URL: string = url;
