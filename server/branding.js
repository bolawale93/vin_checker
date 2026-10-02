// Agency branding shown in the interface and on reports.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getSetting } from './db.js';

export const BRAND_KEYS = ['agencyName', 'agencySubtitle', 'classification', 'footerText'];

export function logoPath() {
  for (const ext of ['png', 'jpg']) {
    const p = path.join(config.brandingDir, `logo.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function getBrand() {
  const brand = {};
  for (const k of BRAND_KEYS) brand[k] = getSetting(`brand.${k}`, '') || '';
  brand.logoPath = logoPath();
  return brand;
}
