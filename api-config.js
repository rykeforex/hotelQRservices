// API Configuration - Update this when deploying to production
// During development: http://localhost:3000
// On GitHub Pages: https://your-deployed-server.railway.app or similar

const API_BASE_URL = 
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3000'
    : 'https://your-server-url.railway.app'; // UPDATE THIS WITH YOUR DEPLOYED SERVER URL

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