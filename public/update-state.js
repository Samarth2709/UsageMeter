(function exposeUpdatePresentation(root) {
  function describeUpdate(state = {}) {
    switch (state.status) {
      case "available":
        return {
          visible: true,
          label: "Update available",
          title: `Download verified Core ${state.version || "update"}`,
          action: "download"
        };
      case "downloading":
        return {
          visible: true,
          label: state.progress ? `Downloading ${state.progress}%` : "Downloading…",
          title: "Downloading and verifying update",
          action: "none",
          disabled: true
        };
      case "downloaded":
        return {
          visible: true,
          label: "Restart now",
          title: `Restart to use ${state.version || "the update"}`,
          action: "restart"
        };
      case "failed":
        return {
          visible: true,
          label: "Retry update",
          title: state.error || "The update could not be verified. Try again.",
          action: "download"
        };
      case "shell-required":
        return {
          visible: true,
          label: "Get new app",
          title: `This update needs Usage Meter ${state.minShellVersion || "with a newer shell"}`,
          action: "shell"
        };
      default:
        return { visible: false, label: "Update", title: "", action: "none" };
    }
  }

  const api = { describeUpdate };
  if (typeof module !== "undefined") module.exports = api;
  root.usageMeterUpdatePresentation = api;
})(typeof window === "undefined" ? globalThis : window);
