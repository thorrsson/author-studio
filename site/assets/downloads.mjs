const releaseApi = 'https://api.github.com/repos/thorrsson/author-studio/releases/latest';
const downloadBase = 'https://github.com/thorrsson/author-studio/releases/download/';
const installers = {
  mac: /^Author-Studio-[\d.]+-universal\.dmg$/,
  windows: /^Author-Studio-Setup-[\d.]+\.exe$/,
  linux: /^Author-Studio-[\d.]+-x86_64\.AppImage$/,
};

export async function getDownloads(fetchRelease = fetch) {
  const response = await fetchRelease(releaseApi, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`GitHub release lookup failed (${response.status}).`);
  const release = await response.json();
  if (release.draft || release.prerelease || !Array.isArray(release.assets)) {
    throw new Error('GitHub did not return a stable release with installers.');
  }
  const downloads = {};
  for (const [platform, pattern] of Object.entries(installers)) {
    const matches = release.assets.filter((asset) => pattern.test(asset.name));
    if (matches.length !== 1) throw new Error(`No unambiguous ${platform} installer in the latest release.`);
    const asset = matches[0];
    const url = new URL(asset.browser_download_url);
    if (!url.href.startsWith(downloadBase) || url.search || url.hash
        || decodeURIComponent(url.pathname.split('/').at(-1)) !== asset.name) {
      throw new Error(`Invalid ${platform} download URL in the latest release.`);
    }
    downloads[platform] = url.href;
  }
  return downloads;
}

export function setupPicker(picker, loadDownloads) {
  const status = picker.querySelector('[role="status"]');
  const list = picker.querySelector('ul');
  const links = picker.querySelectorAll('[data-platform]');
  let loading = false;
  let loaded = false;
  picker.addEventListener('toggle', async () => {
    if (!picker.open || loading || loaded) return;
    loading = true;
    status.textContent = 'Finding the latest stable installers...';
    try {
      const downloads = await loadDownloads();
      for (const link of links) link.href = downloads[link.dataset.platform];
      list.hidden = false;
      status.textContent = 'Choose your platform to download:';
      loaded = true;
    } catch (error) {
      status.textContent = 'Could not load downloads from GitHub. Browse all releases below, or close and reopen to retry.';
      console.error('Author Studio download lookup failed:', error);
    } finally {
      loading = false;
    }
  });
}
