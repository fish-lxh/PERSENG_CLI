import { Routes, Route, Navigate } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { Dashboard } from './pages/Dashboard';
import { Roles } from './pages/Roles';
import { Memory } from './pages/Memory';
import { Chat } from './pages/Chat';
import { Settings } from './pages/Settings';
import { useEffect } from 'react';
import { wsBus } from './lib/ws';

export default function App() {
  useEffect(() => {
    wsBus.reconnect();
    return () => wsBus.close();
  }, []);

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex flex-1 flex-col min-w-0">
        <Topbar />
        <main className="flex-1 overflow-auto p-6">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/roles" element={<Roles />} />
            <Route path="/memory" element={<Memory />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
