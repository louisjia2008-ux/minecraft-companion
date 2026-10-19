import { createRoot } from 'react-dom/client';

import './styles.css';
import { OverlayApp } from './App';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Missing overlay root element.');
}
createRoot(root).render(<OverlayApp />);
