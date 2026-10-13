const SESSION_KEY = "stockly.auth.session.v1";
const THEME_KEY = "stockly.theme.v1";
const INVENTORY_SELECTION_KEY = "stockly.inventory.active.v1";
const MOVEMENT_LIMIT = 1000;
const REPORT_MOVEMENT_LIMIT = 50000;
const RECOVERY_QUESTIONS = [
  ["first_pet", "¿Cómo se llamaba tu primera mascota?"],
  ["birth_city", "¿En qué ciudad naciste?"],
  ["first_school", "¿Cómo se llamaba tu primera escuela?"],
  ["first_job", "¿Cuál fue tu primer trabajo?"],
  ["childhood_friend", "¿Cómo se llamaba un amigo de tu infancia?"],
  ["favorite_teacher", "¿Cómo se apellidaba un profesor que recuerdes?"]
];
const authScreen = document.querySelector("#auth-screen");
const appShell = document.querySelector("#app-shell");
const authForm = document.querySelector("#auth-form");
const authEmail = document.querySelector("#auth-email");
const authPassword = document.querySelector("#auth-password");
const confirmAuthPassword = document.querySelector("#confirm-auth-password");
const confirmPasswordField = document.querySelector("#confirm-password-field");
const authError = document.querySelector("#auth-error");
const authSubmit = document.querySelector("#auth-submit");
const authToggle = document.querySelector("#auth-toggle");
const productList = document.querySelector("#product-list");
const emptyState = document.querySelector("#empty-state");
const searchInput = document.querySelector("#search-input");
const categoryFilter = document.querySelector("#category-filter");
const productModal = document.querySelector("#product-modal");
const movementModal = document.querySelector("#movement-modal");
const toast = document.querySelector("#toast");
const themeToggles = document.querySelectorAll(".theme-toggle");
const appConfig = window.STOCKLY_CONFIG || {};
const supabaseUrl = String(appConfig.supabaseUrl || "").replace(/\/+$/, "");
const supabaseAnonKey = String(appConfig.supabaseAnonKey || "");
const currency = String(appConfig.currency || "USD");
let session = null;
let inventoryAccess = [];
let activeInventoryOwnerId = "";
let products = [];
let movements = [];
let warehouses = [];
let warehouseStocks = [];
let warehouseStockMap = new Map();
let reportMovements = [];
let latestDelivery = null;
let currentView = "inventory";
let isSignUp = false;
let isRefreshing = false;
let cloudDataPromise = null;
let returnToEntryAfterProductCreate = false;
let refreshPromise = null;
let toastTimer;
let pendingRecoveryToken = "";

const authMain = document.querySelector("#auth-main");
const securitySetupPanel = document.querySelector("#security-setup");
const forgotPanel = document.querySelector("#forgot-panel");
const passwordResetPanel = document.querySelector("#password-reset-panel");

function setTheme(theme, persist = false) {
  const selectedTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = selectedTheme;
  document.querySelector('meta[name="theme-color"]').content = selectedTheme === "dark" ? "#10191c" : "#14bec4";
  for (const button of themeToggles) {
    const nextMode = selectedTheme === "dark" ? "claro" : "oscuro";
    button.setAttribute("aria-label", `Cambiar a modo ${nextMode}`);
    button.setAttribute("aria-pressed", String(selectedTheme === "dark"));
    button.querySelector(".theme-icon").textContent = selectedTheme === "dark" ? "☀" : "☾";
    button.querySelector(".theme-label").textContent = selectedTheme === "dark" ? "Modo claro" : "Modo oscuro";
  }
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, selectedTheme);
    } catch (error) {
      showToast("No se pudo guardar la preferencia de tema en este navegador.");
      console.error("Stockly could not save the theme preference.", error);
    }
  }
}

function loadTheme() {
  try {
    setTheme(localStorage.getItem(THEME_KEY) || "light");
  } catch (error) {
    setTheme("light");
    console.error("Stockly could not read the saved theme preference.", error);
  }
}

function money(value) {
  return new Intl.NumberFormat("es", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
}

function safeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3500);
}

function formatApiError(data, fallback) {
  const message = data?.message || data?.msg || data?.error_description || data?.error;
  if (data?.code === "23505") return "Ya existe un producto con ese SKU.";
  if (isExistingAccountError(data?.code || message)) return "Ya existe una cuenta con ese correo.";
  if (typeof message === "string" && /email signups are disabled|signups? (?:are )?disabled|signup is disabled/i.test(message)) {
    return "Supabase tiene desactivados los registros por correo. En Authentication → Settings activa «Allow new users to sign up» y en Authentication → Providers → Email habilita Email. No se creó la cuenta; tus preguntas siguen en pantalla para que puedas intentarlo de nuevo.";
  }
  if (typeof message === "string" && /email rate limit exceeded|over_email_send_rate_limit/i.test(message)) {
    return "Supabase limitó temporalmente el envío de correos. Espera un momento antes de volver a intentarlo.";
  }
  if (typeof message === "string" && message.startsWith("Insufficient stock")) {
    return "No hay suficientes unidades para registrar esa salida o nota de entrega.";
  }
  return typeof message === "string" ? message : fallback;
}

function isExistingAccountError(value) {
  return typeof value === "string" &&
    /user_already_exists|email_exists|already registered|already exists|email.*registered|ya existe una cuenta/i.test(value);
}

async function readResponse(response, fallback) {
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }
  if (!response.ok) throw new Error(formatApiError(data, fallback));
  return data;
}

function storeSession(nextSession) {
  session = {
    ...nextSession,
    expires_at: nextSession.expires_at || Math.floor(Date.now() / 1000) + Number(nextSession.expires_in || 3600)
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch (error) {
    session = null;
    throw new Error("No se pudo guardar la sesión en este navegador. Revisa su configuración de privacidad.", { cause: error });
  }
}

function clearSession() {
  session = null;
  inventoryAccess = [];
  activeInventoryOwnerId = "";
  warehouses = [];
  warehouseStocks = [];
  warehouseStockMap = new Map();
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (error) {
    console.error("Stockly could not clear the saved session.", error);
  }
}

function readSession() {
  try {
    const stored = localStorage.getItem(SESSION_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch (error) {
    clearSession();
    throw new Error("No se pudo leer la sesión guardada. Inicia sesión de nuevo.", { cause: error });
  }
}

async function authRequest(path, body) {
  let response;
  try {
    response = await fetch(`${supabaseUrl}/auth/v1/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: supabaseAnonKey },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error("No se pudo conectar con Supabase. Revisa tu conexión a internet y la URL del proyecto.", { cause: error });
  }
  return readResponse(response, "No se pudo completar la solicitud de acceso.");
}

async function publicRpcRequest(name, body) {
  let response;
  try {
    response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseAnonKey,
        Authorization: `******`
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error("No se pudo conectar con el servicio de recuperación. Revisa tu conexión e inténtalo de nuevo.", { cause: error });
  }
  return readResponse(response, "No se pudo completar la recuperación de la cuenta.");
}

async function refreshSession() {
  if (refreshPromise) return refreshPromise;
  if (!session?.refresh_token) throw new Error("Tu sesión venció. Inicia sesión de nuevo.");
  refreshPromise = authRequest("token?grant_type=refresh_token", { refresh_token: session.refresh_token })
    .then((refreshed) => storeSession(refreshed))
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

async function getAccessToken() {
  if (!session) throw new Error("Inicia sesión para continuar.");
  if (Number(session.expires_at) <= Math.floor(Date.now() / 1000) + 60) await refreshSession();
  return session.access_token;
}

async function apiRequest(path, options = {}) {
  const accessToken = await getAccessToken();
  const headers = {
    apikey: supabaseAnonKey,
    Authorization: `Bearer ${accessToken}`,
    ...options.headers
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      ...options,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
  } catch (error) {
    throw new Error("No se pudo conectar con la base de datos. Revisa tu conexión a internet.", { cause: error });
  }
  if (response.status === 401) {
    await refreshSession();
    return apiRequest(path, options);
  }
  return readResponse(response, "No se pudo guardar el cambio en la nube.");
}

function inventorySelectionStorageKey() {
  return `${INVENTORY_SELECTION_KEY}.${session?.user?.id || "unknown"}`;
}

function activeInventoryQuery(table, fields, extra = "") {
  if (!activeInventoryOwnerId) throw new Error("No se ha seleccionado un inventario.");
  return `${table}?select=${fields}&user_id=eq.${encodeURIComponent(activeInventoryOwnerId)}${extra}`;
}

function renderInventoryAccess() {
  const selector = document.querySelector("#inventory-selector");
  const invitationsButton = document.querySelector("#inventory-invitations-button");
  const manageButton = document.querySelector("#manage-inventory-button");
  selector.innerHTML = inventoryAccess.map((inventory) =>
    `<option value="${safeText(inventory.inventory_owner_id)}">${safeText(inventory.is_owner ? "Mi inventario" : `Compartido por ${inventory.inventory_owner_email || "otro usuario"}`)}</option>`
  ).join("");
  selector.value = activeInventoryOwnerId;
  selector.hidden = inventoryAccess.length < 2;
  invitationsButton.hidden = !hasReceivedInvitations;
  manageButton.hidden = activeInventoryOwnerId !== session?.user?.id;
}

let hasReceivedInvitations = false;

async function refreshInventoryAccess() {
  const [accessRows, invitations] = await Promise.all([
    apiRequest("rpc/get_inventory_access", { method: "POST", body: {} }),
    apiRequest("rpc/list_inventory_invitations", { method: "POST", body: {} })
  ]);
  if (!Array.isArray(accessRows) || !accessRows.some((row) => row.inventory_owner_id === session?.user?.id) ||
      !Array.isArray(invitations)) {
    throw new Error("Supabase devolvió una lista de inventarios o invitaciones no válida.");
  }
  inventoryAccess = accessRows;
  hasReceivedInvitations = invitations.length > 0;
  let storedOwnerId = "";
  try {
    storedOwnerId = localStorage.getItem(inventorySelectionStorageKey()) || "";
  } catch (error) {
    console.error("Stockly could not read the selected inventory preference.", error);
  }
  activeInventoryOwnerId = accessRows.some((row) => row.inventory_owner_id === storedOwnerId)
    ? storedOwnerId
    : session.user.id;
  renderInventoryAccess();
  renderReceivedInvitations(invitations);
}

function renderReceivedInvitations(invitations) {
  const list = document.querySelector("#received-invitations-list");
  list.innerHTML = invitations.length
    ? invitations.map((invitation) => `
      <article class="sharing-list-item">
        <div><strong>${safeText(invitation.owner_email || "Inventario compartido")}</strong><small>Te invita a colaborar en su inventario.</small></div>
        <div class="sharing-actions">
          <button class="button button-primary" type="button" data-invitation-action="accept" data-owner-id="${safeText(invitation.owner_user_id)}">Aceptar</button>
          <button class="button button-secondary" type="button" data-invitation-action="decline" data-owner-id="${safeText(invitation.owner_user_id)}">Rechazar</button>
        </div>
      </article>`).join("")
    : '<p class="sharing-empty">No tienes invitaciones pendientes.</p>';
  const button = document.querySelector("#inventory-invitations-button");
  button.hidden = invitations.length === 0;
  hasReceivedInvitations = invitations.length > 0;
}

async function refreshInventorySharingLists() {
  const [members, pending] = await Promise.all([
    apiRequest("rpc/list_inventory_members", {
      method: "POST",
      body: { p_owner_user_id: activeInventoryOwnerId }
    }),
    apiRequest("rpc/list_pending_inventory_invitations", { method: "POST", body: {} })
  ]);
  if (!Array.isArray(members) || !Array.isArray(pending)) {
    throw new Error("Supabase devolvió datos de colaboración no válidos.");
  }
  document.querySelector("#inventory-members-list").innerHTML = members.length
    ? members.map((member) => `
      <article class="sharing-list-item">
        <div><strong>${safeText(member.member_email || "Cuenta Stockly")}</strong><small>Puede consultar y modificar el inventario.</small></div>
        <button class="button button-secondary" type="button" data-remove-member="${safeText(member.member_user_id)}">Quitar acceso</button>
      </article>`).join("")
    : '<p class="sharing-empty">Todavía no has compartido este inventario.</p>';
  document.querySelector("#inventory-pending-list").innerHTML = pending.length
    ? pending.map((invitation) => `
      <article class="sharing-list-item">
        <div><strong>${safeText(invitation.invited_email || "Cuenta Stockly")}</strong><small>Invitación pendiente de respuesta.</small></div>
        <button class="button button-secondary" type="button" data-remove-member="${safeText(invitation.invited_user_id)}">Cancelar</button>
      </article>`).join("")
    : '<p class="sharing-empty">No hay invitaciones pendientes.</p>';
}

function displayAuth(message = "") {
  authScreen.hidden = false;
  appShell.hidden = true;
  showAuthPanel("main");
  setAuthMessage(message, "error");
}

function showAuthPanel(name) {
  authMain.hidden = name !== "main";
  securitySetupPanel.hidden = name !== "security";
  forgotPanel.hidden = name !== "forgot";
  passwordResetPanel.hidden = name !== "reset";
}

function setAuthMessage(message, type = "error") {
  authError.textContent = message;
  authError.setAttribute("role", type === "success" ? "status" : "alert");
  authError.classList.toggle("form-success", type === "success");
}

function displayApp() {
  authScreen.hidden = true;
  appShell.hidden = false;
  document.querySelector("#user-email").textContent = session.user?.email || "";
  populateProfileForm();
  const initialView = location.hash.startsWith("#view-") ? location.hash.slice("#view-".length) : "inventory";
  setView(initialView);
  window.scrollTo(0, 0);
}

function populateProfileForm() {
  const user = session?.user;
  if (!user) return;
  const metadata = user.user_metadata || {};
  document.querySelector("#profile-name").value = metadata.display_name || metadata.full_name || metadata.name || "";
  document.querySelector("#profile-email").value = user.new_email || user.email || "";
}

async function updateAuthenticatedUser(body, accessToken = null) {
  const token = accessToken || await getAccessToken();
  let response;
  try {
    response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseAnonKey,
        Authorization: `******`
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error("No se pudo conectar con Supabase. Revisa tu conexión e inténtalo de nuevo.", { cause: error });
  }
  return readResponse(response, "No se pudo actualizar la cuenta.");
}

async function handleProfileSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = document.querySelector("#profile-submit");
  const error = document.querySelector("#profile-error");
  const email = document.querySelector("#profile-email").value.trim();
  const displayName = document.querySelector("#profile-name").value.trim();
  error.textContent = "";
  button.disabled = true;
  try {
    const profileUpdate = { data: { ...session.user.user_metadata, display_name: displayName } };
    const requestedEmailChange = email.toLocaleLowerCase("es") !== session.user.email?.toLocaleLowerCase("es") &&
      email.toLocaleLowerCase("es") !== session.user.new_email?.toLocaleLowerCase("es");
    if (requestedEmailChange) profileUpdate.email = email;
    const updatedUser = await updateAuthenticatedUser(profileUpdate);
    if (!updatedUser?.id || updatedUser.id !== session.user.id) {
      throw new Error("Supabase no confirmó la actualización del perfil.");
    }
    storeSession({ ...session, user: updatedUser });
    document.querySelector("#user-email").textContent = updatedUser.email || "";
    document.querySelector("#profile-email").value = updatedUser.new_email || updatedUser.email || email;
    showToast(updatedUser.new_email || requestedEmailChange
      ? "Perfil actualizado. Confirma el cambio desde los correos enviados por Supabase."
      : "Perfil actualizado.");
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
  }
}

async function handleChangePasswordSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = document.querySelector("#change-password-submit");
  const error = document.querySelector("#change-password-error");
  const currentPassword = document.querySelector("#current-password").value;
  const newPassword = document.querySelector("#settings-new-password").value;
  const confirmPassword = document.querySelector("#settings-confirm-password").value;
  if (newPassword !== confirmPassword) {
    error.textContent = "Las contraseñas nuevas no coinciden.";
    return;
  }
  if (currentPassword === newPassword) {
    error.textContent = "La nueva contraseña debe ser diferente a la actual.";
    return;
  }
  error.textContent = "";
  button.disabled = true;
  try {
    const verifiedSession = await authRequest("token?grant_type=password", {
      email: session.user.email,
      password: currentPassword
    });
    if (!verifiedSession.access_token || verifiedSession.user?.id !== session.user.id) {
      throw new Error("La contraseña actual no es correcta.");
    }
    await updateAuthenticatedUser({ password: newPassword }, verifiedSession.access_token);
    form.reset();
    showToast("Contraseña actualizada correctamente.");
  } catch (requestError) {
    error.textContent = /invalid login credentials|invalid_credentials|invalid_grant/i.test(requestError.message)
      ? "La contraseña actual no es correcta."
      : requestError.message;
  } finally {
    button.disabled = false;
  }
}

function setAuthMode(signUp) {
  isSignUp = signUp;
  showAuthPanel("main");
  setAuthMessage("");
  confirmPasswordField.hidden = !signUp;
  confirmAuthPassword.required = signUp;
  confirmAuthPassword.value = "";
  for (const input of [authPassword, confirmAuthPassword]) {
    input.type = "password";
    const toggle = document.querySelector(`[data-password-toggle="${input.id}"]`);
    toggle.setAttribute("aria-label", input === authPassword ? "Mostrar contraseña" : "Mostrar contraseña de confirmación");
    toggle.setAttribute("aria-pressed", "false");
  }
  document.querySelector("#auth-title").textContent = signUp ? "Crear cuenta" : "Inicia sesión";
  document.querySelector("#auth-subtitle").textContent = signUp
    ? "Completa tus datos y define tus preguntas de seguridad para crear tu cuenta."
    : "Accede a tus productos desde cualquiera de tus dispositivos.";
  authSubmit.textContent = signUp ? "Crear cuenta" : "Iniciar sesión";
  authToggle.textContent = signUp ? "¿Ya tienes cuenta? Iniciar sesión" : "¿No tienes cuenta? Crear una";
  authPassword.autocomplete = signUp ? "new-password" : "current-password";
  document.querySelector("#forgot-password-button").hidden = signUp;
}

function setSecuritySetupMode(signUp) {
  document.querySelector("#security-setup-title").textContent = signUp ? "Preguntas para crear tu cuenta" : "Preguntas de seguridad";
  document.querySelector("#security-setup-subtitle").textContent = signUp
    ? "Elige dos preguntas diferentes y sus respuestas. Después se creará tu cuenta de Stockly."
    : "Configura dos respuestas para verificar tu identidad antes de enviarte un enlace de recuperación por correo.";
  document.querySelector("#security-setup-submit").textContent = signUp ? "Crear cuenta" : "Guardar preguntas";
  document.querySelector("#security-cancel-button").hidden = !signUp;
}

function populateRecoveryQuestionSelects() {
  const options = '<option value="">Selecciona una pregunta</option>' + RECOVERY_QUESTIONS.map(([id, label]) =>
    `<option value="${id}">${safeText(label)}</option>`
  ).join("");
  for (const id of ["#setup-question-one", "#setup-question-two", "#forgot-select-one", "#forgot-select-two"]) {
    document.querySelector(id).innerHTML = options;
  }
}

function normalizeRecoveryAnswer(value) {
  return value.trim().toLocaleLowerCase("es").replace(/\s+/g, " ");
}

async function handleSecuritySetup(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = document.querySelector("#security-setup-submit");
  const error = document.querySelector("#security-setup-error");
  const questionOne = document.querySelector("#setup-question-one").value;
  const questionTwo = document.querySelector("#setup-question-two").value;
  const answerOne = normalizeRecoveryAnswer(document.querySelector("#setup-answer-one").value);
  const answerTwo = normalizeRecoveryAnswer(document.querySelector("#setup-answer-two").value);
  const creatingAccount = isSignUp;
  if (!questionOne || !questionTwo || questionOne === questionTwo || answerOne.length < 2 || answerTwo.length < 2) {
    error.textContent = "Elige dos preguntas diferentes e ingresa ambas respuestas.";
    return;
  }
  error.textContent = "";
  submit.disabled = true;
  try {
    if (isSignUp) {
      const credentials = { email: authEmail.value.trim(), password: authPassword.value };
      let result;
      try {
        result = await authRequest("signup", credentials);
      } catch (requestError) {
        if (!isExistingAccountError(requestError.message)) throw requestError;
        authPassword.value = "";
        setAuthMode(false);
        setAuthMessage("Ya existe una cuenta con ese correo. Inicia sesión o usa «¿Olvidaste tu contraseña?» para recuperar el acceso.");
        return;
      }
      if (Array.isArray(result.user?.identities) && result.user.identities.length === 0) {
        authPassword.value = "";
        setAuthMode(false);
        setAuthMessage("Ya existe una cuenta con ese correo. Inicia sesión o usa «¿Olvidaste tu contraseña?» para recuperar el acceso.");
        return;
      }
      if (!result.user?.id) {
        throw new Error("Supabase no confirmó la creación de la cuenta. Verifica la configuración e inténtalo de nuevo.");
      }
      if (!result.session?.access_token || !result.session?.refresh_token) {
        authPassword.value = "";
        setAuthMode(false);
        setAuthMessage("Supabase todavía exige confirmar el correo. Desactiva «Confirm email» en Authentication → Providers → Email para crear la cuenta sin verificación por correo.");
        return;
      }
      storeSession(result);
      authEmail.value = result.user.email || credentials.email;
      authPassword.value = "";
      isSignUp = false;
      setSecuritySetupMode(false);
      await apiRequest("rpc/ensure_user_profile", { method: "POST", body: {} });
    }
    await apiRequest("rpc/save_account_recovery_questions", {
      method: "POST",
      body: {
        p_question_one: questionOne,
        p_answer_one: answerOne,
        p_question_two: questionTwo,
        p_answer_two: answerTwo
      }
    });
    form.reset();
    await refreshInventoryAccess();
    await loadCloudData();
    displayApp();
    showToast(creatingAccount
      ? "Cuenta creada y preguntas de seguridad guardadas."
      : "Preguntas de seguridad guardadas.");
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    submit.disabled = false;
  }
}

function handleForgotEmailSubmit(event) {
  event.preventDefault();
  document.querySelector("#forgot-select-one").value = "";
  document.querySelector("#forgot-select-two").value = "";
  document.querySelector("#forgot-answer-one").value = "";
  document.querySelector("#forgot-answer-two").value = "";
  document.querySelector("#forgot-email-form").hidden = true;
  document.querySelector("#forgot-challenge-form").hidden = false;
  document.querySelector("#forgot-challenge-error").textContent = "";
}

async function handleForgotChallengeSubmit(event) {
  event.preventDefault();
  const submit = document.querySelector("#forgot-submit");
  const error = document.querySelector("#forgot-challenge-error");
  const email = document.querySelector("#forgot-email").value.trim();
  const questionOne = document.querySelector("#forgot-select-one").value;
  const questionTwo = document.querySelector("#forgot-select-two").value;
  const answerOne = normalizeRecoveryAnswer(document.querySelector("#forgot-answer-one").value);
  const answerTwo = normalizeRecoveryAnswer(document.querySelector("#forgot-answer-two").value);
  if (!questionOne || !questionTwo || questionOne === questionTwo) {
    error.textContent = "Selecciona las dos preguntas de seguridad diferentes que configuraste.";
    return;
  }
  error.textContent = "";
  submit.disabled = true;
  try {
    const verified = await publicRpcRequest("verify_account_recovery_answers", {
      p_email: email,
      p_question_one: questionOne,
      p_answer_one: answerOne,
      p_question_two: questionTwo,
      p_answer_two: answerTwo
    });
    if (verified !== true) {
      error.textContent = "No se pudieron validar las respuestas. Revisa los datos o inténtalo más tarde.";
      return;
    }
    const redirectTo = `${location.origin}${location.pathname}`;
    const result = await authRequest(`recover?redirect_to=${encodeURIComponent(redirectTo)}`, { email });
    document.querySelector("#forgot-challenge-form").hidden = true;
    document.querySelector("#forgot-back-button").hidden = true;
    const subtitle = forgotPanel.querySelector(".auth-subtitle");
    subtitle.textContent = "Si los datos coinciden con una cuenta, recibirás un correo con el enlace para elegir una contraseña nueva.";
    document.querySelector("#forgot-email-form").hidden = true;
    if (result?.error) throw new Error("No se pudo enviar el correo de recuperación.");
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    submit.disabled = false;
  }
}

async function handlePasswordResetSubmit(event) {
  event.preventDefault();
  const submit = document.querySelector("#password-reset-submit");
  const error = document.querySelector("#password-reset-error");
  const password = document.querySelector("#new-password").value;
  const confirmation = document.querySelector("#confirm-password").value;
  if (!pendingRecoveryToken) {
    error.textContent = "El enlace de recuperación no es válido o ya venció. Solicita uno nuevo.";
    return;
  }
  if (password !== confirmation) {
    error.textContent = "Las contraseñas no coinciden.";
    return;
  }
  error.textContent = "";
  submit.disabled = true;
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseAnonKey,
        Authorization: `******`
      },
      body: JSON.stringify({ password })
    });
    const updatedUser = await readResponse(response, "No se pudo actualizar la contraseña.");
    pendingRecoveryToken = "";
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    document.querySelector("#password-reset-form").reset();
    setAuthMode(false);
    if (updatedUser?.email) authEmail.value = updatedUser.email;
    setAuthMessage("Contraseña actualizada. Ya puedes iniciar sesión con tu nueva contraseña.", "success");
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    submit.disabled = false;
  }
}

async function loadCloudData() {
  if (!session) return;
  if (cloudDataPromise) {
    await cloudDataPromise;
    if (session) return loadCloudData();
    return;
  }
  isRefreshing = true;
  cloudDataPromise = (async () => {
    try {
      const [productRows, movementRows, warehouseRows, warehouseStockRows] = await Promise.all([
        apiRequest(activeInventoryQuery("products", "id,name,sku,category,cost,stock,minimum,default_warehouse_id", "&order=name.asc")),
        apiRequest(activeInventoryQuery("stock_movements",
          "id,product_id,product_name,type,quantity,note,reference,counterparty,stock_before,stock_after,warehouse_id,created_at",
          `&order=created_at.desc&limit=${MOVEMENT_LIMIT}`)),
        apiRequest(activeInventoryQuery("inventory_warehouses", "id,name,is_default", "&order=name.asc")),
        apiRequest(activeInventoryQuery("product_warehouse_stock", "product_id,warehouse_id,quantity"))
      ]);
      if (!Array.isArray(warehouseRows) || warehouseRows.length === 0 || !Array.isArray(warehouseStockRows)) {
        throw new Error("No hay almacenes configurados para este inventario. Ejecuta la versión actualizada de schema.sql en Supabase.");
      }
      warehouses = warehouseRows.sort((first, second) =>
        Number(second.is_default) - Number(first.is_default) || first.name.localeCompare(second.name, "es"));
      warehouseStocks = warehouseStockRows.map((stock) => ({
        productId: String(stock.product_id),
        warehouseId: stock.warehouse_id,
        quantity: Number(stock.quantity)
      }));
      warehouseStockMap = new Map(warehouseStocks.map((stock) =>
        [`${stock.productId}:${stock.warehouseId}`, stock.quantity]));
      products = productRows.map((product) => ({
        id: String(product.id),
        name: product.name,
        sku: product.sku,
        category: product.category,
        cost: Number(product.cost),
        stock: Number(product.stock),
        minimum: Number(product.minimum),
        defaultWarehouseId: product.default_warehouse_id
      }));
      movements = movementRows.map((movement) => ({
        id: movement.id,
        productId: movement.product_id == null ? "" : String(movement.product_id),
        productName: movement.product_name,
        type: movement.type,
        quantity: Number(movement.quantity),
        note: movement.note,
        reference: movement.reference || "",
        counterparty: movement.counterparty || "",
        stockBefore: movement.stock_before == null ? null : Number(movement.stock_before),
        stockAfter: movement.stock_after == null ? null : Number(movement.stock_after),
        warehouseId: movement.warehouse_id || "",
        warehouseName: warehouses.find((warehouse) => warehouse.id === movement.warehouse_id)?.name || "",
        isTransfer: (movement.reference || "").startsWith("TR-") && movement.note === "Transferencia entre almacenes",
        createdAt: movement.created_at
      }));
      render();
    } finally {
      isRefreshing = false;
    }
  })();
  try {
    await cloudDataPromise;
  } finally {
    cloudDataPromise = null;
  }
}

function getStatus(product) {
  if (product.stock === 0) return { text: "Agotado", className: "status-out" };
  if (product.stock <= product.minimum) return { text: "Stock bajo", className: "status-low" };
  return { text: "En stock", className: "status-in" };
}

function renderStats() {
  document.querySelector("#stat-products").textContent = products.length.toLocaleString("es");
  document.querySelector("#stat-units").textContent = products.reduce((sum, product) => sum + product.stock, 0).toLocaleString("es");
  document.querySelector("#stat-low").textContent = products.filter((product) => product.stock <= product.minimum).length.toLocaleString("es");
  document.querySelector("#stat-value").textContent = money(products.reduce((sum, product) => sum + product.stock * product.cost, 0));
}

function renderCategories() {
  const selected = categoryFilter.value;
  const categories = [...new Set(products.map((product) => product.category.trim()).filter(Boolean))]
    .sort((first, second) => first.localeCompare(second, "es"));
  categoryFilter.innerHTML = '<option value="">Todas las categorías</option>' +
    categories.map((category) => `<option value="${safeText(category)}">${safeText(category)}</option>`).join("");
  if (categories.includes(selected)) categoryFilter.value = selected;
}

function renderProducts() {
  renderStats();
  renderCategories();
  const query = searchInput.value.trim().toLocaleLowerCase("es");
  const category = categoryFilter.value;
  const visible = products.filter((product) => {
    const matchesSearch = `${product.name} ${product.sku} ${product.category}`.toLocaleLowerCase("es").includes(query);
    return matchesSearch && (!category || product.category === category);
  });
  document.querySelector("#result-count").textContent =
    `${visible.length} ${visible.length === 1 ? "producto" : "productos"}`;
  productList.innerHTML = visible.map((product) => {
    const status = getStatus(product);
    const initials = product.name.trim().slice(0, 1) || "?";
    return `<tr>
      <td><div class="product-cell"><span class="product-thumb">${safeText(initials)}</span><div><div class="product-name">${safeText(product.name)}</div><div class="product-category-sub">${safeText(product.category || "Sin categoría")}</div></div></div></td>
      <td class="sku">${safeText(product.sku || "—")}</td>
      <td>${safeText(product.category || "Sin categoría")}</td>
      <td><span class="cost-value">${money(product.cost)}</span></td>
      <td><span class="stock-number">${product.stock}</span> <span class="stock-unit">unid.</span></td>
      <td><span class="status ${status.className}">${status.text}</span></td>
      <td><div class="row-actions"><button class="icon-button" type="button" data-action="edit" data-id="${safeText(product.id)}" aria-label="Editar ${safeText(product.name)}">✎</button><button class="icon-button delete-button" type="button" data-action="delete" data-id="${safeText(product.id)}" aria-label="Eliminar ${safeText(product.name)}">×</button></div></td>
    </tr>`;
  }).join("");
  emptyState.classList.toggle("visible", visible.length === 0);
  if (products.length === 0) {
    document.querySelector("#empty-title").textContent = "Tu inventario está listo";
    document.querySelector("#empty-message").textContent = "Agrega tu primer producto para empezar a llevar el control de tus existencias.";
    document.querySelector("#empty-add-button").hidden = false;
  } else {
    document.querySelector("#empty-title").textContent = "No encontramos productos";
    document.querySelector("#empty-message").textContent = "Prueba con otro nombre o cambia el filtro de categoría.";
    document.querySelector("#empty-add-button").hidden = true;
  }
}

function renderMovements() {
  const list = document.querySelector("#movement-list");
  const recent = movements.slice(0, 8);
  if (recent.length === 0) {
    list.innerHTML = '<div class="movement-empty">Todavía no hay movimientos registrados.</div>';
    return;
  }
  list.innerHTML = recent.map((movement) => {
    const direction = movement.type === "in" ? "in" : "out";
    const label = movement.isTransfer
      ? (direction === "in" ? "Traslado recibido" : "Traslado enviado")
      : direction === "in" ? "Entrada" : "Salida";
    const date = new Date(movement.createdAt);
    const time = Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" }).format(date);
    return `<div class="movement-row">
      <span class="movement-icon ${direction}" aria-hidden="true">${direction === "in" ? "↓" : "↑"}</span>
      <div class="movement-description"><strong>${label} · ${safeText(movement.productName)}</strong><span>${safeText([movement.warehouseName, movement.note || "Sin nota"].filter(Boolean).join(" · "))}</span></div>
      <span class="movement-quantity ${direction}">${direction === "in" ? "+" : "−"}${movement.quantity}</span>
      <span class="movement-time">${safeText(time)}</span>
    </div>`;
  }).join("");
}

function localDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function renderKardex(rows = movements) {
  const productId = document.querySelector("#kardex-product-filter").value;
  const type = document.querySelector("#kardex-type-filter").value;
  const from = document.querySelector("#kardex-from").value;
  const to = document.querySelector("#kardex-to").value;
  const filtered = rows.filter((movement) => {
    const date = localDate(movement.createdAt);
    return (!productId || movement.productId === productId) &&
      (!type || movement.type === type) &&
      (!from || date >= from) &&
      (!to || date <= to);
  });
  document.querySelector("#kardex-count").textContent =
    `${filtered.length} ${filtered.length === 1 ? "movimiento" : "movimientos"}${rows.length >= MOVEMENT_LIMIT ? " · mostrando hasta 1,000 recientes" : ""}`;
  document.querySelector("#kardex-empty").hidden = filtered.length > 0;
  document.querySelector("#kardex-list").innerHTML = filtered.map((movement) => {
    const inbound = movement.type === "in";
    const time = new Intl.DateTimeFormat("es", { dateStyle: "short", timeStyle: "short" }).format(new Date(movement.createdAt));
    const balance = movement.stockAfter === null
      ? "Sin saldo histórico"
      : `${movement.stockBefore} → ${movement.stockAfter}`;
    return `<tr>
      <td>${safeText(time)}</td>
      <td>${safeText(movement.productName)}</td>
      <td>${safeText(movement.warehouseName || "—")}</td>
      <td><span class="status ${inbound ? "status-in" : "status-out"}">${movement.isTransfer ? (inbound ? "Traslado recibido" : "Traslado enviado") : inbound ? "Entrada" : "Salida"}</span></td>
      <td>${safeText(movement.reference || "—")}</td>
      <td>${safeText(movement.counterparty || "—")}</td>
      <td class="quantity-positive">${inbound ? `+${movement.quantity}` : "—"}</td>
      <td class="quantity-negative">${inbound ? "—" : `−${movement.quantity}`}</td>
      <td>${safeText(balance)}</td>
      <td>${safeText(movement.note || "—")}</td>
    </tr>`;
  }).join("");
}

function productOptions(selected = "") {
  return '<option value="">Selecciona un producto</option>' + products.map((product) =>
    `<option value="${safeText(product.id)}" ${product.id === selected ? "selected" : ""}>${safeText(product.name)}${product.sku ? ` · ${safeText(product.sku)}` : ""} · ${product.stock} unid.</option>`
  ).join("");
}

function populateOperationSelectors() {
  const kardexSelect = document.querySelector("#kardex-product-filter");
  const kardexSelected = kardexSelect.value;
  kardexSelect.innerHTML = '<option value="">Todos los productos</option>' + products.map((product) =>
    `<option value="${safeText(product.id)}">${safeText(product.name)}${product.sku ? ` · ${safeText(product.sku)}` : ""}</option>`
  ).join("");
  if (products.some((product) => product.id === kardexSelected)) kardexSelect.value = kardexSelected;
  const productWarehouse = document.querySelector("#product-warehouse");
  const previousProductWarehouse = productWarehouse.value;
  productWarehouse.innerHTML = warehouseOptions(previousProductWarehouse || warehouses.find((item) => item.is_default)?.id);
  for (const selectorId of ["#movement-warehouse", "#entry-warehouse"]) {
    const selector = document.querySelector(selectorId);
    const previous = selector.value;
    selector.innerHTML = warehouseOptions(previous || warehouses.find((item) => item.is_default)?.id);
  }
  const movementWarehouse = document.querySelector("#movement-warehouse");
  const movementProduct = document.querySelector("#movement-product");
  const movementProductId = movementProduct.value;
  movementWarehouse.innerHTML = warehouseOptions(movementWarehouse.value || warehouses.find((item) => item.is_default)?.id, movementProductId);
  const entrySelect = document.querySelector("#entry-product");
  const entrySelected = entrySelect.value;
  entrySelect.innerHTML = productOptions(entrySelected);
  for (const select of document.querySelectorAll(".delivery-product")) {
    const selected = select.value;
    select.innerHTML = productOptions(selected);
    updateDeliveryWarehouseOptions(select.closest(".delivery-item-row"));
  }
  const warehouseFilter = document.querySelector("#warehouse-filter");
  const selectedWarehouse = warehouseFilter.value;
  warehouseFilter.innerHTML = warehouseOptions(selectedWarehouse || warehouses.find((item) => item.is_default)?.id);
  const transferFrom = document.querySelector("#transfer-from");
  transferFrom.innerHTML = warehouseOptions(transferFrom.value || warehouses.find((item) => item.is_default)?.id);
  const transferTo = document.querySelector("#transfer-to");
  transferTo.innerHTML = warehouses
    .filter((warehouse) => warehouse.id !== transferFrom.value)
    .map((warehouse) => `<option value="${safeText(warehouse.id)}">${safeText(warehouse.name)}</option>`).join("");
  renderWarehouseInventory();
  if (document.querySelector("#delivery-items").children.length === 0) addDeliveryItem();
}

function updateDeliveryWarehouseOptions(row) {
  if (!row) return;
  const productId = row.querySelector(".delivery-product").value;
  const warehouseSelect = row.querySelector(".delivery-warehouse");
  const previous = warehouseSelect.value;
  const product = products.find((item) => item.id === productId);
  const selected = warehouses.some((item) => item.id === previous && getWarehouseStock(productId, item.id) > 0)
    ? previous
    : warehouses.find((item) => item.id === product?.defaultWarehouseId && getWarehouseStock(productId, item.id) > 0)?.id
      || warehouses.find((item) => getWarehouseStock(productId, item.id) > 0)?.id
      || warehouses.find((item) => item.is_default)?.id
      || warehouses[0]?.id
      || "";
  warehouseSelect.innerHTML = warehouseOptions(selected, productId);
  const quantity = product && selected ? getWarehouseStock(productId, selected) : 0;
  row.querySelector(".delivery-item-stock").textContent =
    product ? `${quantity.toLocaleString("es")} disponibles en ${warehouses.find((item) => item.id === selected)?.name || "el almacén"}` : "Selecciona un producto";
}

function updateMovementWarehouseOptions(preferredWarehouseId = "") {
  const productId = document.querySelector("#movement-product").value;
  const product = products.find((item) => item.id === productId);
  const availableWarehouse = warehouses.find((item) => item.id === preferredWarehouseId && getWarehouseStock(productId, item.id) > 0)
    || warehouses.find((item) => item.id === product?.defaultWarehouseId && getWarehouseStock(productId, item.id) > 0)
    || warehouses.find((item) => getWarehouseStock(productId, item.id) > 0)
    || warehouses.find((item) => item.is_default)
    || warehouses[0];
  const select = document.querySelector("#movement-warehouse");
  select.innerHTML = warehouseOptions(availableWarehouse?.id || "", productId);
  const stock = getWarehouseStock(productId, select.value);
  const type = document.querySelector("#movement-type").value;
  const quantity = document.querySelector("#movement-quantity");
  document.querySelector("#movement-warehouse-stock").textContent =
    `${stock.toLocaleString("es")} disponibles en el almacén seleccionado.`;
  if (type === "out") quantity.max = String(stock);
  else quantity.removeAttribute("max");
}

function addDeliveryItem() {
  if (document.querySelector("#delivery-items").children.length >= 100) {
    showToast("Una nota de entrega admite hasta 100 productos diferentes.");
    return;
  }
  const row = document.createElement("div");
  row.className = "delivery-item-row";
  row.innerHTML = `<label class="field">Producto<select class="delivery-product" required>${productOptions()}</select><small class="delivery-item-stock">Selecciona un producto</small></label>
    <label class="field">Almacén<select class="delivery-warehouse" required>${warehouseOptions()}</select></label>
    <label class="field">Cantidad<input class="delivery-quantity" type="number" min="1" step="1" value="1" required></label>
    <button class="icon-button delete-button remove-delivery-item" type="button" aria-label="Quitar producto">×</button>`;
  document.querySelector("#delivery-items").append(row);
  updateDeliveryWarehouseOptions(row);
}

function setView(view) {
  const selected = document.querySelector(`[data-view="${CSS.escape(view)}"]`);
  if (!selected) return;
  currentView = view;
  document.querySelectorAll(".app-view").forEach((section) => {
    section.hidden = section !== selected;
  });
  document.querySelectorAll("[data-view-link]").forEach((link) => {
    const active = link.dataset.viewLink === view;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const heading = selected.querySelector("h1")?.textContent || "Inventario";
  document.querySelector(".breadcrumbs strong").textContent = heading;
  if (view === "settings") populateProfileForm();
  if (view === "kardex") renderKardex(movements);
  if (view === "reports") {
    runReport().catch((error) => showToast(`No se pudo generar el reporte: ${error.message}`));
  }
  if (location.hash !== `#view-${view}`) history.replaceState(null, "", `#view-${view}`);
}

function render() {
  renderProducts();
  renderMovements();
  renderKardex(movements);
  populateOperationSelectors();
  renderWarehouseInventory();
}

function getWarehouseStock(productId, warehouseId) {
  return warehouseStockMap.get(`${productId}:${warehouseId}`) || 0;
}

function warehouseOptions(selected = "", productId = "") {
  return warehouses.map((warehouse) => {
    const quantity = productId ? getWarehouseStock(productId, warehouse.id) : null;
    const label = quantity === null ? warehouse.name : `${warehouse.name} · ${quantity} unid.`;
    return `<option value="${safeText(warehouse.id)}" ${warehouse.id === selected ? "selected" : ""}>${safeText(label)}</option>`;
  }).join("");
}

function renderWarehouseInventory() {
  const select = document.querySelector("#warehouse-filter");
  const selected = warehouses.some((warehouse) => warehouse.id === select.value)
    ? select.value
    : warehouses.find((warehouse) => warehouse.is_default)?.id || warehouses[0]?.id || "";
  select.innerHTML = warehouseOptions(selected);
  if (!selected) {
    document.querySelector("#warehouse-stock-list").replaceChildren();
    document.querySelector("#warehouse-stock-empty").hidden = false;
    document.querySelector("#warehouse-view-summary").textContent = "Crea un almacén para comenzar.";
    return;
  }
  select.value = selected;
  const warehouse = warehouses.find((item) => item.id === selected);
  const rows = warehouseStocks
    .filter((stock) => stock.warehouseId === selected && stock.quantity > 0)
    .map((stock) => ({ stock, product: products.find((item) => item.id === stock.productId) }))
    .filter((item) => item.product);
  document.querySelector("#warehouse-view-title").textContent = warehouse.name;
  document.querySelector("#warehouse-view-summary").textContent =
    `${rows.length.toLocaleString("es")} ${rows.length === 1 ? "artículo con existencias" : "artículos con existencias"}`;
  document.querySelector("#warehouse-stock-empty").hidden = rows.length > 0;
  document.querySelector("#warehouse-stock-list").innerHTML = rows.map(({ stock, product }) => `
    <tr>
      <td>${safeText(product.name)}</td>
      <td>${safeText(product.sku || "—")}</td>
      <td>${safeText(product.category || "Sin categoría")}</td>
      <td><strong>${stock.quantity.toLocaleString("es")}</strong></td>
      <td>${product.stock.toLocaleString("es")}</td>
      <td><button class="button button-secondary" type="button" data-transfer-product="${safeText(product.id)}" data-transfer-from="${safeText(selected)}">Transferir</button></td>
    </tr>`).join("");
}

function openProductModal(product, selectInEntryAfterCreate = false) {
  returnToEntryAfterProductCreate = selectInEntryAfterCreate;
  document.querySelector("#product-form").reset();
  document.querySelector("#product-error").textContent = "";
  document.querySelector("#product-id").value = product?.id || "";
  document.querySelector("#product-modal-title").textContent = product ? "Editar producto" : "Nuevo producto";
  document.querySelector("#product-name").value = product?.name || "";
  document.querySelector("#product-sku").value = product?.sku || "";
  document.querySelector("#product-category").value = product?.category || "";
  const warehouseField = document.querySelector("#product-warehouse-field");
  const warehouseSelect = document.querySelector("#product-warehouse");
  warehouseSelect.innerHTML = warehouseOptions(
    product?.defaultWarehouseId || (selectInEntryAfterCreate
      ? document.querySelector("#entry-warehouse").value
      : warehouses.find((item) => item.is_default)?.id)
  );
  warehouseField.hidden = Boolean(product);
  document.querySelector("#product-cost").value = product?.cost ?? 0;
  document.querySelector("#product-stock").value = product?.stock ?? 0;
  document.querySelector("#product-stock").readOnly = Boolean(product);
  document.querySelector("#stock-hint").textContent = product ? "Registra un movimiento para ajustar existencias." : "Existencias iniciales.";
  document.querySelector("#product-minimum").value = product?.minimum ?? 5;
  productModal.showModal();
  document.querySelector("#product-name").focus();
}

function openMovementModal() {
  const select = document.querySelector("#movement-product");
  select.innerHTML = products.map((product) =>
    `<option value="${safeText(product.id)}">${safeText(product.name)} · ${product.stock} unid.</option>`
  ).join("");
  document.querySelector("#movement-error").textContent = "";
  document.querySelector("#movement-quantity").value = "1";
  document.querySelector("#movement-note").value = "";
  updateMovementWarehouseOptions();
  movementModal.showModal();
  select.focus();
}

async function refreshAfterMutation() {
  try {
    await loadCloudData();
  } catch (error) {
    showToast(`El cambio se guardó, pero no se pudo actualizar la vista: ${error.message}`);
  }
}

async function handleProductSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const errorElement = document.querySelector("#product-error");
  const submitButton = event.currentTarget.querySelector('[type="submit"]');
  const existingId = document.querySelector("#product-id").value;
  const sku = String(form.get("sku")).trim();
  const duplicateSku = sku && products.some((product) => product.sku.toLocaleLowerCase("es") === sku.toLocaleLowerCase("es") && product.id !== existingId);
  if (duplicateSku) {
    errorElement.textContent = "Ya existe un producto con ese SKU.";
    return;
  }
  const product = {
    name: String(form.get("name")).trim(),
    sku,
    category: String(form.get("category")).trim(),
    cost: Number(form.get("cost")),
    stock: Number(form.get("stock")),
    minimum: Number(form.get("minimum"))
  };
  const defaultWarehouseId = String(form.get("default_warehouse_id") || "");
  if (!product.name || Object.values(product).some((value) => typeof value === "number" && (!Number.isFinite(value) || value < 0)) ||
      !Number.isSafeInteger(product.stock) || !Number.isSafeInteger(product.minimum)) {
    errorElement.textContent = "Revisa el nombre y asegúrate de que los valores sean válidos.";
    return;
  }
  if (existingId) delete product.stock;
  errorElement.textContent = "";
  submitButton.disabled = true;
  try {
    const savedProduct = await apiRequest(existingId
      ? `products?id=eq.${encodeURIComponent(existingId)}&user_id=eq.${encodeURIComponent(activeInventoryOwnerId)}`
      : "products", {
      method: existingId ? "PATCH" : "POST",
      headers: { Prefer: existingId ? "return=minimal" : "return=representation" },
      body: existingId ? product : {
        ...product,
        user_id: activeInventoryOwnerId,
        default_warehouse_id: defaultWarehouseId
      }
    });
    productModal.close();
    showToast(existingId ? "Producto actualizado." : "Producto agregado.");
    await refreshAfterMutation();
    if (!existingId && returnToEntryAfterProductCreate) {
      const createdProduct = Array.isArray(savedProduct) ? savedProduct[0] : savedProduct;
      if (createdProduct?.id && products.some((item) => item.id === String(createdProduct.id))) {
        document.querySelector("#entry-product").value = String(createdProduct.id);
      }
    }
  } catch (error) {
    errorElement.textContent = error.message;
  } finally {
    returnToEntryAfterProductCreate = false;
    submitButton.disabled = false;
  }
}

async function handleMovementSubmit(event) {
  event.preventDefault();
  const productId = document.querySelector("#movement-product").value;
  const quantity = Number(document.querySelector("#movement-quantity").value);
  const type = document.querySelector("#movement-type").value;
  const warehouseId = document.querySelector("#movement-warehouse").value;
  const error = document.querySelector("#movement-error");
  const submitButton = event.currentTarget.querySelector('[type="submit"]');
  if (!products.some((item) => item.id === productId) || !warehouses.some((item) => item.id === warehouseId) ||
      !Number.isSafeInteger(quantity) || quantity < 1 ||
      (type === "out" && getWarehouseStock(productId, warehouseId) < quantity)) {
    error.textContent = "Selecciona un producto y almacén con existencias suficientes e indica una cantidad válida.";
    return;
  }
  error.textContent = "";
  submitButton.disabled = true;
  try {
    await apiRequest("rpc/register_stock_movement", {
      method: "POST",
      body: {
        p_inventory_owner_id: activeInventoryOwnerId,
        p_product_id: productId,
        p_warehouse_id: warehouseId,
        p_type: type,
        p_quantity: quantity,
        p_note: document.querySelector("#movement-note").value.trim(),
        p_reference: "",
        p_counterparty: ""
      }
    });
    movementModal.close();
    showToast(type === "in" ? "Entrada registrada." : "Salida registrada.");
    await refreshAfterMutation();
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    submitButton.disabled = false;
  }
}

async function handleStockEntrySubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const error = document.querySelector("#entry-error");
  const productId = document.querySelector("#entry-product").value;
  const warehouseId = document.querySelector("#entry-warehouse").value;
  const quantity = Number(document.querySelector("#entry-quantity").value);
  if (!products.some((product) => product.id === productId) || !warehouses.some((item) => item.id === warehouseId) ||
      !Number.isSafeInteger(quantity) || quantity < 1) {
    error.textContent = "Selecciona un producto y almacén e indica una cantidad entera válida.";
    return;
  }
  error.textContent = "";
  button.disabled = true;
  try {
    await apiRequest("rpc/register_stock_movement", {
      method: "POST",
      body: {
        p_inventory_owner_id: activeInventoryOwnerId,
        p_product_id: productId,
        p_warehouse_id: warehouseId,
        p_type: "in",
        p_quantity: quantity,
        p_note: document.querySelector("#entry-note").value.trim(),
        p_reference: document.querySelector("#entry-reference").value.trim(),
        p_counterparty: document.querySelector("#entry-counterparty").value.trim()
      }
    });
    form.reset();
    document.querySelector("#entry-quantity").value = "1";
    showToast("Ingreso de mercancía registrado.");
    await refreshAfterMutation();
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
  }
}

async function handleDeliverySubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const error = document.querySelector("#delivery-error");
  const customer = document.querySelector("#delivery-customer").value.trim();
  const note = document.querySelector("#delivery-note").value.trim();
  const items = [...document.querySelectorAll(".delivery-item-row")].map((row) => ({
    product_id: row.querySelector(".delivery-product").value,
    warehouse_id: row.querySelector(".delivery-warehouse").value,
    quantity: Number(row.querySelector(".delivery-quantity").value)
  }));
  if (!customer || items.length === 0 || items.some((item) =>
    !products.some((product) => product.id === item.product_id) ||
    !warehouses.some((warehouse) => warehouse.id === item.warehouse_id) ||
    getWarehouseStock(item.product_id, item.warehouse_id) < item.quantity ||
    !Number.isSafeInteger(item.quantity) || item.quantity < 1
  )) {
    error.textContent = "Indica un destinatario, almacenes con existencias suficientes y cantidades enteras válidas.";
    return;
  }
  if (new Set(items.map((item) => `${item.product_id}:${item.warehouse_id}`)).size !== items.length) {
    error.textContent = "Cada producto puede aparecer una sola vez por almacén en la nota.";
    return;
  }
  const snapshot = items.map((item) => {
    const product = products.find((entry) => entry.id === item.product_id);
    const warehouse = warehouses.find((entry) => entry.id === item.warehouse_id);
    return { ...item, name: product.name, sku: product.sku, warehouseName: warehouse.name };
  });
  error.textContent = "";
  button.disabled = true;
  try {
    const response = await apiRequest("rpc/create_delivery_note", {
      method: "POST",
      body: { p_inventory_owner_id: activeInventoryOwnerId, p_customer: customer, p_note: note, p_items: items }
    });
    const delivery = Array.isArray(response) ? response[0] : response;
    if (!delivery?.id || !delivery?.folio) throw new Error("La nota se guardó, pero el servidor no devolvió su folio.");
    latestDelivery = {
      id: delivery.id,
      folio: delivery.folio,
      customer,
      note,
      createdAt: new Date().toISOString(),
      items: snapshot
    };
    form.reset();
    document.querySelector("#delivery-items").replaceChildren();
    addDeliveryItem();
    document.querySelector("#latest-delivery").hidden = false;
    document.querySelector("#latest-delivery-summary").textContent =
      `${latestDelivery.folio} · ${customer} · ${snapshot.length} ${snapshot.length === 1 ? "producto" : "productos"}`;
    showToast(`Nota de entrega ${latestDelivery.folio} creada.`);
    await refreshAfterMutation();
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
  }
}

function printDeliveryNote(delivery) {
  if (!delivery) {
    showToast("No hay una nota de entrega para imprimir.");
    return;
  }
  const date = new Intl.DateTimeFormat("es", { dateStyle: "long", timeStyle: "short" }).format(new Date(delivery.createdAt));
  document.querySelector("#delivery-print").innerHTML = `
    <header><div class="delivery-document-brand"><img src="./brand-symbol.png" alt=""><span>Stockly</span></div><div class="delivery-document-folio"><strong>${safeText(delivery.folio)}</strong><br>${safeText(date)}</div></header>
    <h2 id="delivery-preview-title">Nota de entrega</h2>
    <div class="delivery-document-meta"><span><strong>Destinatario:</strong> ${safeText(delivery.customer)}</span><span><strong>Folio:</strong> ${safeText(delivery.folio)}</span></div>
    <table><thead><tr><th>Producto</th><th>SKU</th><th>Almacén</th><th>Cantidad</th></tr></thead>
      <tbody>${delivery.items.map((item) => `<tr><td>${safeText(item.name)}</td><td>${safeText(item.sku || "—")}</td><td>${safeText(item.warehouseName || "—")}</td><td>${item.quantity}</td></tr>`).join("")}</tbody>
    </table>
    <p class="delivery-document-note"><strong>Observaciones:</strong> ${safeText(delivery.note || "Sin observaciones")}</p>`;
  document.querySelector("#delivery-preview").showModal();
}

async function fetchMovementsForPeriod(from, to) {
  const start = new Date(`${from}T00:00:00`).toISOString();
  const endDate = new Date(`${to}T00:00:00`);
  endDate.setDate(endDate.getDate() + 1);
  const end = endDate.toISOString();
  const result = [];
  for (let offset = 0; offset < REPORT_MOVEMENT_LIMIT; offset += MOVEMENT_LIMIT) {
    const query = new URLSearchParams({
      select: "id,product_id,product_name,type,quantity,note,reference,counterparty,stock_before,stock_after,warehouse_id,created_at",
      and: `(created_at.gte.${start},created_at.lt.${end})`,
      order: "created_at.desc",
      limit: String(Math.min(MOVEMENT_LIMIT, REPORT_MOVEMENT_LIMIT - offset)),
      offset: String(offset)
    });
    query.set("user_id", `eq.${activeInventoryOwnerId}`);
    const page = await apiRequest(`stock_movements?${query.toString()}`);
    result.push(...page.map((movement) => ({
      id: movement.id,
      productId: movement.product_id == null ? "" : String(movement.product_id),
      productName: movement.product_name,
      type: movement.type,
      quantity: Number(movement.quantity),
      note: movement.note || "",
      reference: movement.reference || "",
      counterparty: movement.counterparty || "",
      stockBefore: movement.stock_before == null ? null : Number(movement.stock_before),
      stockAfter: movement.stock_after == null ? null : Number(movement.stock_after),
      warehouseId: movement.warehouse_id || "",
      warehouseName: warehouses.find((warehouse) => warehouse.id === movement.warehouse_id)?.name || "",
      isTransfer: (movement.reference || "").startsWith("TR-") && movement.note === "Transferencia entre almacenes",
      createdAt: movement.created_at
    })));
    if (page.length < MOVEMENT_LIMIT) return { movements: result, truncated: false };
  }
  return { movements: result, truncated: true };
}

async function runReport() {
  const from = document.querySelector("#report-from").value;
  const to = document.querySelector("#report-to").value;
  const period = document.querySelector("#report-period");
  if (!from || !to || from > to) {
    period.textContent = "Selecciona un rango de fechas válido.";
    period.classList.add("form-error");
    return;
  }
  period.classList.remove("form-error");
  period.textContent = "Generando…";
  try {
    const result = await fetchMovementsForPeriod(from, to);
    reportMovements = result.movements;
    const externalMovements = reportMovements.filter((movement) => !movement.isTransfer);
    const incoming = externalMovements.filter((movement) => movement.type === "in").reduce((sum, movement) => sum + movement.quantity, 0);
    const outgoing = externalMovements.filter((movement) => movement.type === "out").reduce((sum, movement) => sum + movement.quantity, 0);
    document.querySelector("#report-in").textContent = incoming.toLocaleString("es");
    document.querySelector("#report-out").textContent = outgoing.toLocaleString("es");
    document.querySelector("#report-products").textContent = products.length.toLocaleString("es");
    document.querySelector("#report-value").textContent = money(products.reduce((sum, product) => sum + product.stock * product.cost, 0));
    document.querySelector("#report-stock-empty").hidden = products.length > 0;
    document.querySelector("#report-stock-list").innerHTML = products.map((product) => {
      const status = getStatus(product);
      return `<tr><td>${safeText(product.name)}</td><td>${safeText(product.sku || "—")}</td><td>${product.stock}</td><td>${product.minimum}</td><td><span class="status ${status.className}">${status.text}</span></td><td>${money(product.stock * product.cost)}</td></tr>`;
    }).join("");
    period.textContent = `${from} — ${to} · ${reportMovements.length.toLocaleString("es")} movimientos${result.truncated ? " · reporte limitado a 50,000 movimientos" : ""}`;
  } catch (error) {
    period.textContent = `No se pudo generar: ${error.message}`;
    period.classList.add("form-error");
    throw error;
  }
}

function downloadCsv(filename, rows) {
  const csv = "\uFEFF" + rows.map((row) =>
    row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")
  ).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function exportKardexCsv() {
  const productId = document.querySelector("#kardex-product-filter").value;
  const type = document.querySelector("#kardex-type-filter").value;
  const from = document.querySelector("#kardex-from").value;
  const to = document.querySelector("#kardex-to").value;
  const filtered = movements.filter((movement) => {
    const date = localDate(movement.createdAt);
    return (!productId || movement.productId === productId) && (!type || movement.type === type) &&
      (!from || date >= from) && (!to || date <= to);
  });
  const rows = [["Fecha", "Producto", "Almacén", "Tipo", "Documento", "Contacto", "Entrada", "Salida", "Saldo anterior", "Saldo actual", "Detalle"]];
  for (const movement of filtered) {
    rows.push([
      movement.createdAt, movement.productName, movement.warehouseName,
      movement.isTransfer ? (movement.type === "in" ? "Traslado recibido" : "Traslado enviado") : movement.type === "in" ? "Entrada" : "Salida",
      movement.reference, movement.counterparty, movement.type === "in" ? movement.quantity : "",
      movement.type === "out" ? movement.quantity : "", movement.stockBefore ?? "",
      movement.stockAfter ?? "", movement.note
    ]);
  }
  downloadCsv("kardex-stockly.csv", rows);
  showToast("Kárdex exportado.");
}

function exportReportCsv() {
  const rows = [["Reporte de inventario"], ["Desde", document.querySelector("#report-from").value],
    ["Hasta", document.querySelector("#report-to").value], [], ["Producto", "SKU", "Existencias", "Mínimo", "Estado", "Valor en costo"]];
  for (const product of products) {
    rows.push([product.name, product.sku, product.stock, product.minimum, getStatus(product).text, product.stock * product.cost]);
  }
  rows.push([], ["Fecha", "Producto", "Almacén", "Tipo", "Cantidad", "Documento", "Contacto", "Detalle"]);
  for (const movement of reportMovements) {
    rows.push([movement.createdAt, movement.productName, movement.warehouseName,
      movement.isTransfer ? (movement.type === "in" ? "Traslado recibido" : "Traslado enviado") : movement.type === "in" ? "Entrada" : "Salida",
      movement.quantity, movement.reference, movement.counterparty, movement.note]);
  }
  downloadCsv("reporte-stockly.csv", rows);
  showToast("Reporte exportado.");
}

function exportCsv() {
  const rows = [["Producto", "SKU", "Categoría", "Costo", "Existencias", "Mínimo"]];
  for (const product of products) {
    rows.push([product.name, product.sku, product.category, product.cost, product.stock, product.minimum]);
  }
  downloadCsv("inventario-stockly.csv", rows);
  showToast("Inventario exportado.");
}

function exportInventoryPdf() {
  if (products.length === 0) {
    showToast("Agrega productos antes de exportar el inventario a PDF.");
    return;
  }
  const report = document.querySelector("#inventory-print-report");
  const generatedAt = new Intl.DateTimeFormat("es", { dateStyle: "long" }).format(new Date());
  const totalValue = products.reduce((sum, product) => sum + product.stock * product.cost, 0);
  report.innerHTML = `
    <header class="inventory-print-header">
      <div>
        <p class="inventory-print-eyebrow">STOCKLY · INVENTARIO</p>
        <h1>Existencias actuales</h1>
        <p>Generado el ${safeText(generatedAt)} · ${products.length.toLocaleString("es")} ${products.length === 1 ? "producto" : "productos"}</p>
      </div>
      <div class="inventory-print-total"><span>Valor total al costo</span><strong>${safeText(money(totalValue))}</strong></div>
    </header>
    <table class="inventory-print-table">
      <thead><tr><th>Producto</th><th>SKU</th><th>Categoría</th><th>Costo unitario</th><th>Existencias</th><th>Mínimo</th><th>Estado</th></tr></thead>
      <tbody>${products.map((product) => {
        const status = getStatus(product);
        return `<tr>
          <td>${safeText(product.name)}</td>
          <td>${safeText(product.sku || "—")}</td>
          <td>${safeText(product.category || "—")}</td>
          <td>${safeText(money(product.cost))}</td>
          <td>${product.stock.toLocaleString("es")}</td>
          <td>${product.minimum.toLocaleString("es")}</td>
          <td>${safeText(status.text)}</td>
        </tr>`;
      }).join("")}</tbody>
    </table>`;
  const originalTitle = document.title;
  document.title = `Stockly-inventario-${localDate(new Date())}`;
  report.hidden = false;
  window.addEventListener("afterprint", () => {
    report.hidden = true;
    document.title = originalTitle;
  }, { once: true });
  window.print();
}

async function handleWarehouseCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const name = document.querySelector("#warehouse-name").value.trim();
  const error = document.querySelector("#warehouse-error");
  const submit = form.querySelector('[type="submit"]');
  if (!name || warehouses.some((warehouse) => warehouse.name.toLocaleLowerCase("es") === name.toLocaleLowerCase("es"))) {
    error.textContent = "Escribe un nombre y verifica que no exista otro almacén con ese nombre.";
    return;
  }
  error.textContent = "";
  submit.disabled = true;
  try {
    const created = await apiRequest("inventory_warehouses", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: { user_id: activeInventoryOwnerId, name }
    });
    form.reset();
    document.querySelector("#warehouse-modal").close();
    await loadCloudData();
    const row = Array.isArray(created) ? created[0] : created;
    if (row?.id) document.querySelector("#warehouse-filter").value = row.id;
    renderWarehouseInventory();
    showToast("Almacén creado.");
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    submit.disabled = false;
  }
}

function openWarehouseTransfer(productId, sourceWarehouseId) {
  const availableProducts = products.filter((product) => getWarehouseStock(product.id, sourceWarehouseId) > 0);
  if (availableProducts.length === 0 || warehouses.length < 2) {
    showToast(warehouses.length < 2 ? "Crea otro almacén para poder transferir existencias." : "No hay existencias para transferir desde este almacén.");
    return;
  }
  const productSelect = document.querySelector("#transfer-product");
  productSelect.innerHTML = availableProducts.map((product) =>
    `<option value="${safeText(product.id)}" ${product.id === productId ? "selected" : ""}>${safeText(product.name)} · ${getWarehouseStock(product.id, sourceWarehouseId)} unid.</option>`
  ).join("");
  document.querySelector("#transfer-from").innerHTML = warehouseOptions(sourceWarehouseId);
  const destinationSelect = document.querySelector("#transfer-to");
  destinationSelect.innerHTML = warehouses.filter((warehouse) => warehouse.id !== sourceWarehouseId)
    .map((warehouse) => `<option value="${safeText(warehouse.id)}">${safeText(warehouse.name)}</option>`).join("");
  const selectedProductId = productSelect.value;
  document.querySelector("#transfer-quantity").max = String(getWarehouseStock(selectedProductId, sourceWarehouseId));
  document.querySelector("#transfer-quantity").value = "1";
  document.querySelector("#warehouse-transfer-error").textContent = "";
  document.querySelector("#warehouse-transfer-modal").showModal();
}

async function handleWarehouseTransfer(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const error = document.querySelector("#warehouse-transfer-error");
  const productId = document.querySelector("#transfer-product").value;
  const sourceWarehouseId = document.querySelector("#transfer-from").value;
  const destinationWarehouseId = document.querySelector("#transfer-to").value;
  const quantity = Number(document.querySelector("#transfer-quantity").value);
  if (!productId || !sourceWarehouseId || !destinationWarehouseId || sourceWarehouseId === destinationWarehouseId ||
      !Number.isSafeInteger(quantity) || quantity < 1 || getWarehouseStock(productId, sourceWarehouseId) < quantity) {
    error.textContent = "Selecciona dos almacenes distintos y una cantidad disponible válida.";
    return;
  }
  error.textContent = "";
  button.disabled = true;
  try {
    await apiRequest("rpc/transfer_inventory_stock", {
      method: "POST",
      body: {
        p_inventory_owner_id: activeInventoryOwnerId,
        p_product_id: productId,
        p_from_warehouse_id: sourceWarehouseId,
        p_to_warehouse_id: destinationWarehouseId,
        p_quantity: quantity
      }
    });
    document.querySelector("#warehouse-transfer-modal").close();
    showToast("Existencias transferidas entre almacenes.");
    await refreshAfterMutation();
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
  }
}

async function openInventorySharing() {
  try {
    await refreshInventorySharingLists();
    document.querySelector("#inventory-sharing-modal").showModal();
  } catch (error) {
    showToast(`No se pudo cargar la colaboración: ${error.message}`);
  }
}

async function handleInventoryInvite(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = document.querySelector("#inventory-invite-submit");
  const error = document.querySelector("#inventory-invite-error");
  const email = document.querySelector("#inventory-invite-email").value.trim();
  error.textContent = "";
  button.disabled = true;
  try {
    await apiRequest("rpc/invite_inventory_member", {
      method: "POST",
      body: { p_email: email }
    });
    form.reset();
    await refreshInventorySharingLists();
    showToast("Invitación enviada dentro de Stockly.");
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
  }
}

async function handleInvitationAction(button) {
  const ownerId = button.dataset.ownerId;
  const action = button.dataset.invitationAction;
  if (!ownerId || !["accept", "decline"].includes(action)) return;
  button.disabled = true;
  try {
    await apiRequest(`rpc/${action === "accept" ? "accept_inventory_invitation" : "decline_inventory_invitation"}`, {
      method: "POST",
      body: { p_owner_user_id: ownerId }
    });
    await refreshInventoryAccess();
    if (action === "accept") {
      activeInventoryOwnerId = ownerId;
      latestDelivery = null;
      document.querySelector("#latest-delivery").hidden = true;
      try {
        localStorage.setItem(inventorySelectionStorageKey(), ownerId);
      } catch (error) {
        console.error("Stockly could not save the selected inventory preference.", error);
      }
      renderInventoryAccess();
      await loadCloudData();
      document.querySelector("#inventory-invitations-modal").close();
      showToast("Invitación aceptada. Ya puedes trabajar en el inventario compartido.");
    } else {
      showToast("Invitación rechazada.");
    }
  } catch (error) {
    showToast(`No se pudo procesar la invitación: ${error.message}`);
    button.disabled = false;
  }
}

async function removeInventoryAccess(button) {
  const memberId = button.dataset.removeMember;
  if (!memberId) return;
  if (!confirm("¿Quitar o cancelar el acceso de esta cuenta?")) return;
  button.disabled = true;
  try {
    await apiRequest("rpc/remove_inventory_member", {
      method: "POST",
      body: { p_member_user_id: memberId }
    });
    await Promise.all([refreshInventorySharingLists(), refreshInventoryAccess()]);
    showToast("Acceso actualizado.");
  } catch (error) {
    showToast(`No se pudo actualizar el acceso: ${error.message}`);
    button.disabled = false;
  }
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  setAuthMessage("");
  if (isSignUp && authPassword.value !== confirmAuthPassword.value) {
    setAuthMessage("Las contraseñas no coinciden. Verifícalas para crear la cuenta.");
    confirmAuthPassword.focus();
    return;
  }
  authSubmit.disabled = true;
  authToggle.disabled = true;
  authSubmit.textContent = isSignUp ? "Continuando..." : "Validando acceso...";
  let accessVerified = false;
  try {
    const credentials = { email: authEmail.value.trim(), password: authPassword.value };
    if (isSignUp) {
      document.querySelector("#setup-question-one").value = "";
      document.querySelector("#setup-answer-one").value = "";
      document.querySelector("#setup-question-two").value = "";
      document.querySelector("#setup-answer-two").value = "";
      document.querySelector("#security-setup-error").textContent = "";
      setSecuritySetupMode(true);
      showAuthPanel("security");
      return;
    }
    const result = await authRequest("token?grant_type=password", credentials);
    if (!result.access_token || !result.refresh_token || !result.user?.id ||
        result.user.email?.toLocaleLowerCase("es") !== credentials.email.toLocaleLowerCase("es")) {
      throw new Error("No se pudo verificar la cuenta. Comprueba tu correo y contraseña e inténtalo de nuevo.");
    }
    accessVerified = true;
    storeSession(result);
    await apiRequest("rpc/ensure_user_profile", { method: "POST", body: {} });
    const hasRecoveryQuestions = await apiRequest("rpc/has_account_recovery_questions", { method: "POST", body: {} });
    if (hasRecoveryQuestions !== true) {
      setSecuritySetupMode(false);
      showAuthPanel("security");
      return;
    }
    await refreshInventoryAccess();
    await loadCloudData();
    displayApp();
    showToast("Inicio de sesión exitoso.");
  } catch (error) {
    clearSession();
    displayAuth(accessVerified
      ? `Inicio de sesión validado, pero no se pudo cargar el inventario: ${error.message}`
      : error.message);
  } finally {
    authSubmit.disabled = false;
    authToggle.disabled = false;
    authSubmit.textContent = isSignUp ? "Crear cuenta" : "Iniciar sesión";
  }
}

async function signOut() {
  const currentSession = session;
  clearSession();
  products = [];
  movements = [];
  render();
  displayAuth();
  try {
    if (currentSession?.access_token) {
      await fetch(`${supabaseUrl}/auth/v1/logout`, {
        method: "POST",
        headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${currentSession.access_token}` }
      });
    }
  } catch (error) {
    console.error("Stockly could not revoke the remote session; local credentials were cleared.", error);
  }
}

async function initialize() {
  if (!supabaseUrl || !supabaseAnonKey) {
    displayAuth("Configura la URL y la clave pública de Supabase en config.js para conectar la aplicación.");
    authSubmit.disabled = true;
    authToggle.disabled = true;
    return;
  }
  const recoveryParams = new URLSearchParams(location.hash.slice(1));
  if (recoveryParams.get("type") === "recovery" && recoveryParams.get("access_token")) {
    pendingRecoveryToken = recoveryParams.get("access_token");
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    authScreen.hidden = false;
    appShell.hidden = true;
    showAuthPanel("reset");
    return;
  }
  if (recoveryParams.has("error")) {
    const message = recoveryParams.get("error_description") || "El enlace de recuperación no es válido o ya venció. Solicita uno nuevo.";
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    displayAuth(message);
    return;
  }
  try {
    session = readSession();
    if (!session?.access_token) {
      displayAuth();
      return;
    }
    await apiRequest("rpc/ensure_user_profile", { method: "POST", body: {} });
    const hasRecoveryQuestions = await apiRequest("rpc/has_account_recovery_questions", { method: "POST", body: {} });
    if (hasRecoveryQuestions !== true) {
      setSecuritySetupMode(false);
      showAuthPanel("security");
      return;
    }
    await refreshInventoryAccess();
    await loadCloudData();
    displayApp();
  } catch (error) {
    clearSession();
    displayAuth(error.message);
  }
}

document.querySelector("#add-product-button").addEventListener("click", () => openProductModal());
document.querySelector("#empty-add-button").addEventListener("click", () => openProductModal());
document.querySelector("#entry-add-product-button").addEventListener("click", () => openProductModal(undefined, true));
document.querySelector("#profile-form").addEventListener("submit", handleProfileSubmit);
document.querySelector("#change-password-form").addEventListener("submit", handleChangePasswordSubmit);
document.querySelector("#add-movement-button").addEventListener("click", () => {
  if (products.length === 0) {
    showToast("Agrega un producto antes de registrar movimientos.");
    return;
  }
  openMovementModal();
});
document.querySelectorAll("[data-view-link]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    setView(link.dataset.viewLink);
  });
});
window.addEventListener("hashchange", () => {
  const view = location.hash.startsWith("#view-") ? location.hash.slice("#view-".length) : "inventory";
  setView(view);
});
document.querySelector("#export-button").addEventListener("click", exportCsv);
document.querySelector("#export-pdf-button").addEventListener("click", exportInventoryPdf);
document.querySelector("#export-kardex-button").addEventListener("click", exportKardexCsv);
document.querySelector("#export-report-button").addEventListener("click", exportReportCsv);
document.querySelector("#manage-inventory-button").addEventListener("click", openInventorySharing);
document.querySelector("#inventory-invite-form").addEventListener("submit", handleInventoryInvite);
document.querySelector("#inventory-sharing-modal").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-member]");
  if (button) removeInventoryAccess(button);
});
document.querySelector("#inventory-invitations-button").addEventListener("click", () =>
  document.querySelector("#inventory-invitations-modal").showModal());
document.querySelector("#received-invitations-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-invitation-action]");
  if (button) handleInvitationAction(button);
});
document.querySelector("#inventory-selector").addEventListener("change", async (event) => {
  const previousOwnerId = activeInventoryOwnerId;
  const selected = inventoryAccess.find((inventory) => inventory.inventory_owner_id === event.currentTarget.value);
  if (!selected) {
    renderInventoryAccess();
    return;
  }
  activeInventoryOwnerId = selected.inventory_owner_id;
  warehouses = [];
  warehouseStocks = [];
  warehouseStockMap = new Map();
  latestDelivery = null;
  document.querySelector("#latest-delivery").hidden = true;
  renderInventoryAccess();
  try {
    try {
      localStorage.setItem(inventorySelectionStorageKey(), activeInventoryOwnerId);
    } catch (storageError) {
      console.error("Stockly could not save the selected inventory preference.", storageError);
    }
    await loadCloudData();
    if (currentView === "reports") await runReport();
    showToast(selected.is_owner ? "Tu inventario está activo." : "Inventario compartido activo.");
  } catch (error) {
    activeInventoryOwnerId = previousOwnerId;
    renderInventoryAccess();
    try {
      await loadCloudData();
    } catch (reloadError) {
      console.error("Stockly could not restore the previous inventory after a failed switch.", reloadError);
    }
    showToast(`No se pudo cambiar de inventario: ${error.message}`);
  }
});
document.querySelector("#add-warehouse-button").addEventListener("click", () => {
  document.querySelector("#warehouse-form").reset();
  document.querySelector("#warehouse-error").textContent = "";
  document.querySelector("#warehouse-modal").showModal();
  document.querySelector("#warehouse-name").focus();
});
document.querySelector("#warehouse-form").addEventListener("submit", handleWarehouseCreate);
document.querySelector("#warehouse-stock-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-transfer-product]");
  if (button) openWarehouseTransfer(button.dataset.transferProduct, button.dataset.transferFrom);
});
document.querySelector("#warehouse-filter").addEventListener("change", renderWarehouseInventory);
document.querySelector("#warehouse-transfer-form").addEventListener("submit", handleWarehouseTransfer);
document.querySelector("#transfer-product").addEventListener("change", (event) => {
  const productId = event.currentTarget.value;
  const sourceId = document.querySelector("#transfer-from").value;
  document.querySelector("#transfer-quantity").max = String(getWarehouseStock(productId, sourceId));
});
document.querySelector("#transfer-from").addEventListener("change", (event) => {
  const sourceId = event.currentTarget.value;
  const destination = document.querySelector("#transfer-to");
  destination.innerHTML = warehouses.filter((warehouse) => warehouse.id !== sourceId)
    .map((warehouse) => `<option value="${safeText(warehouse.id)}">${safeText(warehouse.name)}</option>`).join("");
  const productId = document.querySelector("#transfer-product").value;
  document.querySelector("#transfer-quantity").max = String(getWarehouseStock(productId, sourceId));
});
document.querySelector("#movement-product").addEventListener("change", () => updateMovementWarehouseOptions());
document.querySelector("#movement-warehouse").addEventListener("change", () =>
  updateMovementWarehouseOptions(document.querySelector("#movement-warehouse").value));
document.querySelector("#movement-type").addEventListener("change", () =>
  updateMovementWarehouseOptions(document.querySelector("#movement-warehouse").value));
document.querySelector("#run-report-button").addEventListener("click", () => {
  runReport().catch((error) => showToast(`No se pudo generar el reporte: ${error.message}`));
});
document.querySelector("#kardex-filter-button").addEventListener("click", () => renderKardex(movements));
document.querySelector("#kardex-product-filter").addEventListener("change", () => renderKardex(movements));
document.querySelector("#kardex-type-filter").addEventListener("change", () => renderKardex(movements));
document.querySelector("#stock-entry-form").addEventListener("submit", handleStockEntrySubmit);
document.querySelector("#delivery-form").addEventListener("submit", handleDeliverySubmit);
document.querySelector("#add-delivery-item").addEventListener("click", addDeliveryItem);
document.querySelector("#delivery-items").addEventListener("change", (event) => {
  if (event.target.matches(".delivery-product, .delivery-warehouse")) {
    updateDeliveryWarehouseOptions(event.target.closest(".delivery-item-row"));
  }
});
document.querySelector("#delivery-items").addEventListener("click", (event) => {
  const remove = event.target.closest(".remove-delivery-item");
  if (!remove) return;
  const row = remove.closest(".delivery-item-row");
  if (document.querySelectorAll(".delivery-item-row").length === 1) {
    row.querySelector(".delivery-product").value = "";
    row.querySelector(".delivery-quantity").value = "1";
    updateDeliveryWarehouseOptions(row);
  } else {
    row.remove();
  }
});
document.querySelector("#print-delivery-button").addEventListener("click", () => printDeliveryNote(latestDelivery));
document.querySelector("#print-preview-button").addEventListener("click", () => window.print());
document.querySelector("#close-delivery-preview").addEventListener("click", () => document.querySelector("#delivery-preview").close());
document.querySelector("#signout-button").addEventListener("click", signOut);
document.querySelector("#forgot-password-button").addEventListener("click", () => {
  document.querySelector("#forgot-email").value = authEmail.value.trim();
  document.querySelector("#forgot-email-form").hidden = false;
  document.querySelector("#forgot-challenge-form").hidden = true;
  document.querySelector("#forgot-back-button").hidden = false;
  forgotPanel.querySelector(".auth-subtitle").textContent = "Escribe el correo de tu cuenta para continuar.";
  document.querySelector("#forgot-error").textContent = "";
  showAuthPanel("forgot");
});
document.querySelector("#forgot-back-button").addEventListener("click", () => setAuthMode(false));
document.querySelectorAll("[data-password-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.passwordToggle);
    const showing = input.type === "password";
    input.type = showing ? "text" : "password";
    button.setAttribute("aria-pressed", String(showing));
    button.setAttribute("aria-label", showing
      ? (input === authPassword ? "Ocultar contraseña" : "Ocultar contraseña de confirmación")
      : (input === authPassword ? "Mostrar contraseña" : "Mostrar contraseña de confirmación"));
  });
});
document.querySelector("#security-setup-form").addEventListener("submit", handleSecuritySetup);
document.querySelector("#security-cancel-button").addEventListener("click", () => {
  authPassword.value = "";
  confirmAuthPassword.value = "";
  setAuthMode(false);
});
document.querySelector("#forgot-email-form").addEventListener("submit", handleForgotEmailSubmit);
document.querySelector("#forgot-challenge-form").addEventListener("submit", handleForgotChallengeSubmit);
document.querySelector("#password-reset-form").addEventListener("submit", handlePasswordResetSubmit);
themeToggles.forEach((button) => {
  button.addEventListener("click", () => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
  });
});
document.querySelector("#product-form").addEventListener("submit", handleProductSubmit);
document.querySelector("#movement-form").addEventListener("submit", handleMovementSubmit);
authForm.addEventListener("submit", handleAuthSubmit);
authToggle.addEventListener("click", () => setAuthMode(!isSignUp));
populateRecoveryQuestionSelects();
searchInput.addEventListener("input", renderProducts);
categoryFilter.addEventListener("change", renderProducts);
productList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const product = products.find((item) => item.id === button.dataset.id);
  if (!product) return;
  if (button.dataset.action === "edit") {
    openProductModal(product);
  } else if (button.dataset.action === "delete" && confirm(`¿Eliminar "${product.name}" del inventario?`)) {
    button.disabled = true;
    try {
      await apiRequest(`products?id=eq.${encodeURIComponent(product.id)}&user_id=eq.${encodeURIComponent(activeInventoryOwnerId)}`, { method: "DELETE" });
      showToast("Producto eliminado.");
      await refreshAfterMutation();
    } catch (error) {
      showToast(error.message);
      button.disabled = false;
    }
  }
});
document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => document.getElementById(button.dataset.close).close());
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchInput.focus();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && session && !isRefreshing) {
    loadCloudData().catch((error) => showToast(`No se pudo sincronizar: ${error.message}`));
  }
});

setInterval(() => {
  if (document.visibilityState === "visible" && session && !isRefreshing) {
    loadCloudData().catch((error) => showToast(`No se pudo sincronizar: ${error.message}`));
  }
}, 30000);

initialize();
loadTheme();
const today = new Date();
const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
document.querySelector("#report-from").value = localDate(firstDay);
document.querySelector("#report-to").value = localDate(today);

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((error) => {
      console.error("Stockly service worker registration failed.", error);
    });
  });
}
