import { getDownloads, setupPicker } from './downloads.mjs';

const pickers = document.querySelectorAll('.download-picker');
let request;
function loadDownloads() {
  request ??= getDownloads().catch((error) => {
    request = undefined;
    throw error;
  });
  return request;
}

for (const picker of pickers) {
  setupPicker(picker, loadDownloads);
  picker.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      picker.open = false;
      picker.querySelector('summary').focus();
    }
  });
}

document.addEventListener('click', (event) => {
  for (const picker of pickers) {
    if (!picker.contains(event.target)) picker.open = false;
  }
});
