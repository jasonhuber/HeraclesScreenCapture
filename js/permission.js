const grantButton = document.getElementById("grantButton");
const statusElement = document.getElementById("permissionStatus");

grantButton.addEventListener("click", async () => {
  grantButton.disabled = true;
  statusElement.textContent = "Waiting for the Chrome permission prompt...";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());

    statusElement.textContent = "Microphone access granted. This tab closes itself in a moment.";

    try {
      chrome.runtime.sendMessage({ type: "heracles-mic-permission", granted: true });
    } catch (error) {
      // The side panel may be closed; the permission itself is already stored by Chrome.
    }

    setTimeout(() => {
      window.close();
    }, 1500);
  } catch (error) {
    grantButton.disabled = false;
    statusElement.textContent =
      "Microphone access was blocked. Click the camera/microphone icon in the address bar to allow it, then try again.";

    try {
      chrome.runtime.sendMessage({ type: "heracles-mic-permission", granted: false });
    } catch (messageError) {
      // Ignore: the side panel may be closed.
    }
  }
});
