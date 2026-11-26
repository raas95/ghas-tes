function tampilkan(nama) {
  document.innerHTML = "<h1>Halo " + nama + "</h1>"; // XSS
}

// GHAS secret scanning test - token palsu (format valid, bukan token asli)
const GITHUB_TOKEN = "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";
