import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout.jsx';
import { CatalogPage } from './pages/CatalogPage.jsx';
import { VideoDetailPage } from './pages/VideoDetailPage.jsx';
import { SearchPage } from './pages/SearchPage.jsx';
import { ChannelPage } from './pages/ChannelPage.jsx';
import { CreatorsPage } from './pages/CreatorsPage.jsx';
import { CreatorPage } from './pages/CreatorPage.jsx';
import { SourcesPage } from './pages/SourcesPage.jsx';
import { SettingsPage } from './pages/SettingsPage.jsx';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<CatalogPage />} />
        <Route path="/videos/:id" element={<VideoDetailPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/creators" element={<CreatorsPage />} />
        <Route path="/creators/:id" element={<CreatorPage />} />
        <Route path="/channels/:key" element={<ChannelPage />} />
        <Route path="/sources" element={<SourcesPage />} />
        {/* Archiviati è diventata la vista "Nascosti" della Libreria. */}
        <Route path="/archived" element={<Navigate to="/?vista=nascosti" replace />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
