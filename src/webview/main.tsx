import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Fast JSON Viewer root element is missing.');
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
