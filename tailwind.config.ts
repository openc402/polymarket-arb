import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
      },
      colors: {
        dark: {
          950: '#050510',
          900: '#080814',
          800: '#0f0f1e',
          700: '#16162a',
          600: '#1e1e38',
          500: '#2a2a4a',
        },
        profit: '#00ff88',
        loss: '#ff4466',
        accent: '#6366f1',
        violet: '#8b5cf6',
      },
      animation: {
        'fade-in-up': 'fadeInUp 0.6s ease-out forwards',
        'fade-in': 'fadeIn 0.4s ease-out forwards',
        'slide-in-left': 'slideInLeft 0.5s ease-out forwards',
        'pulse-glow': 'pulseGlow 2s ease-in-out infinite',
        'border-glow': 'borderGlow 3s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
export default config;
