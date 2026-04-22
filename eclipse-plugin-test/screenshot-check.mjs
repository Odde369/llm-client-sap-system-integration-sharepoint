import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
// networkidle times out — use domcontentloaded + wait for a bit
await page.goto('http://localhost:3080/', { waitUntil: 'domcontentloaded', timeout: 15000 });
// wait for React to mount
await page.waitForTimeout(5000);
await page.screenshot({ path: 'librechat-state.png', fullPage: true });
console.log('URL:', page.url());
console.log('Title:', await page.title());
const elements = await page.evaluate(() => {
  return [...document.querySelectorAll('input, textarea, button, [role="button"], a')]
    .slice(0, 20)
    .map(el => ({ tag: el.tagName, type: el.type, placeholder: el.placeholder, testid: el.dataset.testid, text: el.textContent?.trim().substring(0, 40) }));
});
console.log('Elements:', JSON.stringify(elements, null, 2));
await browser.close();
