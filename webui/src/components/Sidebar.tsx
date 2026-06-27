import { NavLink } from 'react-router-dom';

const items = [
  { to: '/', label: 'Dashboard', icon: '◐' },
  { to: '/chat', label: 'Chat', icon: '✦' },
  { to: '/roles', label: 'Roles', icon: '◆' },
  { to: '/memory', label: 'Memory', icon: '◈' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

export function Sidebar() {
  return (
    <aside className="w-52 shrink-0 border-r border-slate-200 bg-white flex flex-col">
      <div className="px-5 py-4 border-b border-slate-200">
        <div className="text-base font-semibold text-slate-900">PersEng</div>
        <div className="text-xs text-slate-500">WebUI</div>
      </div>
      <nav className="flex-1 p-2 space-y-1">
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded text-sm transition-colors ${
                isActive
                  ? 'bg-brand-50 text-brand-700 font-medium'
                  : 'text-slate-700 hover:bg-slate-50'
              }`
            }
          >
            <span className="text-base">{it.icon}</span>
            <span>{it.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="p-3 text-xs text-slate-400 border-t border-slate-200">
        127.0.0.1:7717
      </div>
    </aside>
  );
}
