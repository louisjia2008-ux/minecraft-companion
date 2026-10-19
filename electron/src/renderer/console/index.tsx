import { createRoot } from 'react-dom/client';

import './app.css';
import { ConsoleApp } from './App';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Missing renderer root element.');
}
createRoot(root).render(<ConsoleApp />);
