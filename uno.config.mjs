import { defineConfig, presetWind4 } from 'unocss'

export default defineConfig({
  theme: {
    colors: {
      primary: {
        300: '#69c4b8',
        400: '#42a99d',
        600: '#267d74',
        DEFAULT: '#2f8f83',
      },
    },
    fontFamily: {
      sans: '"Avenir Next", Avenir, "Segoe UI", system-ui, sans-serif',
      mono: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    },
    fontSize: {
      micro: ['0.625rem', '0.875rem'],
      mini: ['0.6875rem', '1rem'],
      compact: ['0.8125rem', '1.125rem'],
    },
  },
  shortcuts: [
    {
      'color-base': 'text-slate-800 dark:text-slate-100',
      'color-fade': 'text-slate-500 dark:text-slate-400',
      'color-active': 'text-primary-600 dark:text-primary-300',
      'bg-base': 'bg-[#e9eef5] dark:bg-[#151a22]',
      'bg-secondary': 'bg-[#dde4ed] dark:bg-[#1c222c]',
      'border-base': 'border-slate-400/20 dark:border-slate-300/12',
      'border-active': 'border-primary-600/25 dark:border-primary-300/25',
      'app-shell': 'h-screen min-h-0 flex flex-col overflow-hidden bg-base color-base font-sans antialiased',
      'soft-panel': 'rounded-5 border border-base bg-base shadow-[7px_7px_18px_#c8ced6,-7px_-7px_18px_#f8fafc] dark:shadow-[7px_7px_18px_#0d1117,-7px_-7px_18px_#202936]',
      'soft-inset': 'rounded-4 border border-base bg-secondary shadow-[inset_3px_3px_7px_#c6cdd6,inset_-3px_-3px_7px_#f6f9fc] dark:shadow-[inset_3px_3px_7px_#10151c,inset_-3px_-3px_7px_#252d38]',
      'btn-action': 'min-h-10 inline-flex items-center justify-center gap-2 rounded-4 border border-base px-4 text-sm font-600 color-base bg-base shadow-[4px_4px_10px_#c6cdd6,-4px_-4px_10px_#f8fafc] dark:shadow-[4px_4px_10px_#0d1117,-4px_-4px_10px_#222b37] hover:text-primary-600 dark:hover:text-primary-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400 active:translate-y-px active:shadow-[inset_2px_2px_5px_#c6cdd6,inset_-2px_-2px_5px_#f8fafc] dark:active:shadow-[inset_2px_2px_5px_#0d1117,inset_-2px_-2px_5px_#222b37] disabled:pointer-events-none disabled:opacity-40 transition-[color,opacity,transform] duration-150',
      'btn-primary': 'btn-action border-primary-600/25 bg-primary-600 dark:bg-primary-300 text-slate-50 dark:text-slate-950 shadow-[4px_4px_10px_#bec5ce,-3px_-3px_8px_#f8fafc] dark:shadow-[4px_4px_10px_#0d1117,-3px_-3px_8px_#222b37] hover:text-slate-50 dark:hover:text-slate-950',
      'btn-icon': 'btn-action h-10 w-10 p-0',
      'field-base': 'min-h-10 w-full rounded-4 border border-base bg-secondary px-3 text-sm color-base shadow-[inset_2px_2px_5px_#c6cdd6,inset_-2px_-2px_5px_#f8fafc] dark:shadow-[inset_2px_2px_5px_#0e1319,inset_-2px_-2px_5px_#252d38] outline-none placeholder:text-slate-400 focus:border-primary-400/50',
      'status-badge': 'inline-flex min-h-6 items-center gap-1.5 rounded-full border px-2 text-[0.6875rem] leading-4 font-600',
      'section-label': 'text-[0.6875rem] leading-4 font-700 uppercase tracking-[0.12em] color-fade',
      'z-top-nav': 'z-60',
      'z-panel-content': 'z-70',
      'z-toast': 'z-100',
      'tap-scale': 'active:scale-[0.97] transition-transform duration-100',
    },
  ],
  presets: [presetWind4()],
})
