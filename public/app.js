// Small progressive enhancements. Everything works without JavaScript.
(function () {
  // Phones: wide tables turn into stacked cards. Copy each column header onto its cells
  // so the card view can show "Label: value" (CSS does the rest under the mobile breakpoint).
  document.querySelectorAll('table.data').forEach(function (table) {
    if (table.classList.contains('raw')) return;
    var heads = Array.prototype.map.call(table.querySelectorAll('thead th'), function (th) { return th.textContent.trim(); });
    if (heads.length < 3) return; // short two-column lists already fit
    table.classList.add('cards');
    table.querySelectorAll('tbody tr').forEach(function (tr) {
      Array.prototype.forEach.call(tr.children, function (td, i) {
        if (td.colSpan > 1) td.classList.add('full');
        else if (heads[i] && !td.hasAttribute('data-label')) td.setAttribute('data-label', heads[i]);
      });
    });
  });
  // Phones: long filter forms keep the search box and buttons visible; the rest folds
  // behind a "More filters" button (left open when any of those filters is in use).
  if (window.matchMedia('(max-width: 760px)').matches) {
    document.querySelectorAll('form.filters').forEach(function (form) {
      var extras = Array.prototype.filter.call(form.children, function (el, i) {
        return i > 0 && !el.matches('button, .btn, a, [type=hidden]') && !el.querySelector('button');
      });
      if (extras.length < 3) return;
      var inUse = extras.some(function (el) {
        return Array.prototype.some.call(el.matches('input, select') ? [el] : el.querySelectorAll('input, select'), function (f) {
          return f.type === 'checkbox' ? f.checked : f.value !== '';
        });
      });
      extras.forEach(function (el) { el.classList.add('extra'); });
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ghost morebtn';
      var setLabel = function () { btn.textContent = form.classList.contains('folded') ? 'More filters (' + extras.length + ')' : 'Fewer filters'; };
      if (!inUse) form.classList.add('folded');
      setLabel();
      btn.addEventListener('click', function () { form.classList.toggle('folded'); setLabel(); });
      form.insertBefore(btn, extras[0]);
    });
  }

  // Close the phone menu after choosing a link.
  var toggle = document.getElementById('navtoggle');
  if (toggle) document.querySelectorAll('header.top nav a').forEach(function (a) { a.addEventListener('click', function () { toggle.checked = false; }); });
})();
