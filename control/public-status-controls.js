(() => {
    const refreshMs = Number(document.currentScript.dataset.refresh) * 1000;
    const dialog = document.querySelector('[aria-labelledby="activity-title"]');
    const form = dialog.querySelector('form');
    const account = document.querySelector('#dashboard-account');
    const signIn = document.querySelector('#dashboard-sign-in');
    const signInForm = signIn.querySelector('form');
    const password = signInForm.querySelector('#dashboard-password');
    const signInMessage = signInForm.querySelector('[role="status"]');
    const signInSubmit = signInForm.querySelector('[type="submit"]');
    const tasks = form.querySelector('select');
    const taskField = form.querySelector('#activity-task');
    const title = form.querySelector('h2');
    const message = form.querySelector('[role="status"]');
    const submit = form.querySelector('button[type="submit"]');
    const close = form.querySelector('#activity-close');
    let refresh;
    let selected;
    let action;
    let dialogVersion = 0;
    let signedIn = false;
    let configured = true;
    let pendingButton;
    let setupCode = /^#setup=([a-f0-9]{64})$/.exec(window.location.hash)?.[1];
    if (setupCode) history.replaceState(null, '', window.location.pathname + window.location.search);

    function scheduleRefresh() {
        refresh = setTimeout(() => window.location.reload(), refreshMs);
    }
    scheduleRefresh();

    function setSignedIn(value) {
        signedIn = value;
        account.textContent = value ? 'Sign out' : 'Sign in';
    }

    function openSignIn(button) {
        clearTimeout(refresh);
        pendingButton = button;
        password.autocomplete = configured ? 'current-password' : 'new-password';
        password.minLength = configured ? 0 : 12;
        signInSubmit.textContent = configured ? 'Sign in' : 'Set password and sign in';
        const needsLink = !configured && !setupCode;
        signInSubmit.disabled = needsLink;
        password.disabled = needsLink;
        signInMessage.textContent = needsLink ? 'Open your one-time dashboard setup link.' : '';
        signIn.showModal();
    }

    const sessionReady = request('/bots/activity?session=status')
        .then(state => {
            configured = state.configured;
            setSignedIn(state.signedIn);
            if (!configured && setupCode && !signIn.open) openSignIn();
        }).catch(() => {});
    account.addEventListener('click', async () => {
        await sessionReady;
        if (!signedIn) {
            openSignIn();
            return;
        }
        account.disabled = true;
        try {
            await request('/bots/activity?session=logout', {});
            setSignedIn(false);
        } catch (error) {
            openSignIn();
            signInMessage.textContent = error.message;
        } finally {
            account.disabled = false;
        }
    });
    signInForm.querySelector('[type="button"]').addEventListener('click', () => {
        if (!signInSubmit.disabled || password.disabled) signIn.close();
    });
    signIn.addEventListener('cancel', event => {
        if (signInSubmit.disabled && !password.disabled) event.preventDefault();
    });
    signIn.addEventListener('close', () => {
        signInForm.reset();
        pendingButton = undefined;
        if (!dialog.open) scheduleRefresh();
    });
    signInForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (signInSubmit.disabled) return;
        signInSubmit.disabled = true;
        try {
            await request(configured ? '/bots/activity?session=login' : '/bots/activity?session=setup',
                configured ? { password: password.value } : { password: password.value, code: setupCode });
            configured = true;
            setupCode = undefined;
            setSignedIn(true);
            const button = pendingButton;
            signIn.close();
            if (button) button.click();
        } catch (error) {
            signInMessage.textContent = error.message;
        } finally {
            password.value = '';
            signInSubmit.disabled = false;
        }
    });

    for (const button of document.querySelectorAll('[data-bot][data-action]')) {
        button.addEventListener('click', async () => {
            await sessionReady;
            if (!signedIn) {
                openSignIn(button);
                return;
            }
            clearTimeout(refresh);
            selected = button;
            action = button.dataset.action;
            title.textContent = button.textContent + ' for ' + button.dataset.bot;
            submit.textContent = action === 'start' ? 'Load activities' : 'Stop activity';
            submit.disabled = false;
            taskField.hidden = true;
            message.textContent = '';
            dialog.showModal();
            if (action === 'start') form.requestSubmit();
        });
    }
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', event => {
        if (close.disabled) event.preventDefault();
    });
    dialog.addEventListener('close', () => {
        dialogVersion++;
        form.reset();
        tasks.replaceChildren();
        if (!signIn.open && !dialog.open) scheduleRefresh();
    });

    async function request(path, payload) {
        const headers = {};
        const options = {
            headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
            signal: AbortSignal.timeout(payload?.action === 'stop' ? 38000 : 15000),
        };
        if (payload !== undefined) {
            headers['Content-Type'] = 'application/json';
            options.method = 'POST';
            options.body = JSON.stringify(payload);
        }
        let response;
        try {
            response = await fetch(path, options);
        } catch {
            throw new Error('The control API did not respond. Check the activity before retrying.');
        }
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(result.error || 'The control API could not complete the request.');
            error.status = response.status;
            throw error;
        }
        return result;
    }

    function updateRow(state) {
        if (state.bot !== selected.dataset.bot) return;
        const running = state.task || state.starting;
        selected.dataset.action = running ? 'stop' : 'start';
        selected.textContent = running ? 'Stop activity' : 'Start activity';
        const activity = state.task?.name?.replaceAll('-', ' ');
        selected.closest('tr').querySelector('[data-activity]').textContent =
            activity ? (state.task.stopping ? 'Stopping ' + activity : activity)
                : state.starting ? 'Starting ' + state.starting.replaceAll('-', ' ')
                    : state.startError ? 'Activity could not start' : '—';
    }

    async function watchStart(version, bot) {
        try {
            while (dialog.open && dialogVersion === version) {
                const state = await request('/bots/activity');
                if (dialogVersion !== version) return;
                if (state.bot !== bot) throw new Error('The configured bot changed.');
                updateRow(state);
                if (!state.starting) {
                    message.textContent = state.startError || (state.task ? 'Activity started.' : 'The activity is no longer running.');
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 1600));
            }
        } catch (error) {
            if (dialogVersion === version) message.textContent = error.message;
        }
    }

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (submit.disabled) return;
        submit.disabled = true;
        close.disabled = true;
        message.textContent = 'Checking controller status…';
        let completed = false;
        let watching = false;
        try {
            const state = await request('/bots/activity');
            if (state.bot !== selected.dataset.bot) {
                throw new Error('The configured bot changed. Close this dialog and refresh the dashboard.');
            }
            if (action === 'stop') {
                if (state.task || state.starting) {
                    message.textContent = 'Stopping activity…';
                    await request('/bots/activity', { bot: state.bot, action: 'stop' });
                }
                message.textContent = state.task || state.starting ? 'Activity stopped.' : 'There is no activity to stop.';
                updateRow({ ...state, task: null, starting: null, startError: null });
            } else {
                if (state.task || state.starting) {
                    updateRow(state);
                    completed = true;
                    message.textContent = 'An activity is already running.';
                    return;
                }
                const names = Array.isArray(state.tasks)
                    ? state.tasks.filter(name => typeof name === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(name))
                    : [];
                if (names.length === 0) throw new Error('No activities are configured for this bot.');
                if (taskField.hidden || !names.includes(tasks.value)) {
                    tasks.replaceChildren(...names.map(name => new Option(name.replaceAll('-', ' '), name)));
                    taskField.hidden = false;
                    submit.textContent = 'Start activity';
                    message.textContent = 'Choose an activity, then select Start activity.';
                    tasks.focus();
                    return;
                }
                const task = tasks.value;
                await request('/bots/activity', { bot: state.bot, action: 'start', task });
                message.textContent = state.client ? 'Starting activity…' : 'Starting the game client and activity…';
                updateRow({ ...state, starting: task, startError: null });
                watching = true;
                void watchStart(dialogVersion, state.bot);
                return;
            }
            completed = true;
        } catch (error) {
            if (error.status === 401) {
                setSignedIn(false);
                dialog.close();
                openSignIn(selected);
                return;
            }
            message.textContent = error.message;
        } finally {
            submit.disabled = completed || watching;
            close.disabled = false;
        }
    });
})();
