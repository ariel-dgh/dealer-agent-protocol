(() => {
  if (navigator.globalPrivacyControl || navigator.doNotTrack === "1") return;
  window.dataLayer = window.dataLayer || [];
  function gtag(){ window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("consent", "default", { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
  gtag("js", new Date());
  gtag("config", "G-7KEVNFFKBZ", { anonymize_ip: true });
  const script = document.createElement("script");
  script.async = true;
  script.src = "https://www.googletagmanager.com/gtag/js?id=G-7KEVNFFKBZ";
  document.head.append(script);
})();
