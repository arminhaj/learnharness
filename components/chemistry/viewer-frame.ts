/** Isolate 3Dmol's WebGL context, body handlers, and internal observers.
 * Removing the iframe tears down the entire viewer, including resources that
 * 3Dmol's public clear() API does not dispose. No molecular data is interpolated
 * into executable HTML: it crosses the checked postMessage channel instead. */
export function viewerFrameHtml(scriptUrl: string, channel: string): string {
	return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#viewer{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}#viewer{position:relative}canvas{touch-action:none}</style></head><body><div id="viewer" aria-label="Rotatable molecular model"></div><script src=${JSON.stringify(scriptUrl)}></script><script>
(() => {
  const channel = ${JSON.stringify(channel)};
  let viewer;
  function notify(type, extra) { parent.postMessage({channel, type, ...extra}, '*'); }
  function style(mode) {
    viewer.setStyle({}, mode === 'sticks' ? {stick:{radius:0.17}} : {stick:{radius:0.12}, sphere:{scale:0.26}});
    viewer.render();
  }
  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.data?.channel !== channel) return;
    const message = event.data;
    try {
      if (message.type === 'hello') { notify('ready', {}); }
      else if (message.type === 'clear') { if (viewer) viewer.clear(); }
      else if (message.type === 'model') {
        if (!viewer) {
          const library = window.$3Dmol || window['3Dmol'];
          if (!library) throw new Error('The 3D viewer did not load.');
          viewer = library.createViewer(document.getElementById('viewer'), {backgroundAlpha:0, antialias:true});
          viewer.setBackgroundColor(0, 0);
        }
        viewer.clear();
        const model = viewer.addModel(message.sdf, 'sdf');
        if (!model.selectedAtoms({}).length) throw new Error('No atoms were found in this model.');
        style(message.style);
        viewer.zoomTo();
        viewer.resize();
        viewer.render();
        notify('rendered', {});
      } else if (viewer && message.type === 'style') style(message.style);
      else if (viewer && message.type === 'rotate') { viewer.rotate(message.angle, message.axis); viewer.render(); }
      else if (viewer && message.type === 'zoom') { viewer.zoom(message.factor); viewer.render(); }
      else if (viewer && message.type === 'reset') { viewer.zoomTo(); viewer.render(); }
      else if (viewer && message.type === 'resize') { viewer.resize(); viewer.render(); }
    } catch (error) { notify('error', {error: error instanceof Error ? error.message : String(error)}); }
  });
  notify('ready', {});
})();
</script></body></html>`;
}
