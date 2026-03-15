/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',
  images: { unoptimized: true },
  // Ensure trailing slashes for static export on GitHub Pages
  trailingSlash: true,
};
export default config;
