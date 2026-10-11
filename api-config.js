// API Configuration - Update this when deploying to production
// During development: http://localhost:3000
// On GitHub Pages: https://your-deployed-server.onrender.com or similar

const API_BASE_URL = (() => {
  const local = 'http://localhost:3000';
  const production = [
    'https://hotel-q-rservices.vercel.app',
    'https://hotelqrservices-production.up.railway.app',
    'https://hotelqrservices.onrender.com'
  ];

  const host = window.location.hostname;
  if (window.location.protocol === 'file:' || !host || host === 'localhost' || host === '127.0.0.1') {
    return local;
  }

  if (host.includes('vercel.app')) {
    return window.location.origin;
  }

  return production[0];
})();

// Helper function for API calls
async function apiCall(endpoint, options = {}) {
  const url = API_BASE_URL + endpoint;
  const config = {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  };
  
  try {
    const res = await fetch(url, config);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`API call failed to ${endpoint}:`, err);
    throw err;
  }
}

// Export for use in modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { API_BASE_URL, apiCall };
}