(function () {
    'use strict';

    const VERSION        = 'v6.2';
    const SNIFFER_ACTIEF = true;   // ← false = sniffer volledig uitgeschakeld (geen interceptie, geen paneel)
    const SHEET_URL      = "https://script.google.com/macros/s/AKfycbzxYBAlxct3qSvZ4j1tX02fEumeeG6sFpwxCNR9lw4xbjVO4OJ7UqoVrAQW71HI8Iy5/exec";
    const SPREADSHEET_URL = "https://docs.google.com/spreadsheets/d/1b4Vvlzs0PN5mqlHk-Na0of0i4VwyD09_DSV4Xe60M4w/edit";

    if (!SNIFFER_ACTIEF) return;

    const origFetch = window.fetch;
    const origOpen  = XMLHttpRequest.prototype.open;
    const origSend  = XMLHttpRequest.prototype.send;

    // =========================================================
    // SESSIEGEBRUIKER
    // =========================================================
    function getBiqsUser() {
        try {
            const cookieValue = document.cookie.split('; ').find(row => row.startsWith('__bdve-uuid='));
            if (cookieValue) {
                const rawBase64 = decodeURIComponent(cookieValue.split('=')[1]).replace('Basic ', '');
                const decoded   = atob(rawBase64);
                if (decoded.includes(':')) return decoded.split(':')[0];
                return decoded;
            }
        } catch (e) {}

        try {
            for (const key of Object.keys(localStorage)) {
                const val = localStorage.getItem(key);
                if (!val) continue;
                try {
                    const obj = JSON.parse(val);
                    if (obj && obj.email)    return obj.email;
                    if (obj && obj.username) return obj.username;
                    if (obj && obj.user && obj.user.email) return obj.user.email;
                } catch (_) {
                    if (val.includes('@') && val.length < 100) return val;
                }
            }
        } catch (e) {}

        return 'Onbekend';
    }

    const GEBRUIKER = getBiqsUser();

    // =========================================================
    // BODY PARSER
    // =========================================================
    function parseBody(raw) {
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (_) {}
        if (typeof raw === 'string' && raw.includes('=')) {
            const obj = {};
            raw.split('&').forEach(p => {
                const idx = p.indexOf('=');
                if (idx === -1) return;
                const k = decodeURIComponent(p.slice(0, idx).replace(/\+/g, ' '));
                const v = decodeURIComponent(p.slice(idx + 1).replace(/\+/g, ' '));
                obj[k] = v;
            });
            return obj;
        }
        return raw;
    }

    // =========================================================
    // CACHES
    // =========================================================
    const eventCache        = {};
    const examCache         = {};
    const deleteReasonCache = {};
    const paymentCache      = {};

    function updateEventCache(responseBody) {
        if (!Array.isArray(responseBody)) return;
        responseBody.forEach(function(evt) {
            if (!evt.id || !evt.instructorId) return;
            eventCache[evt.id] = {
                instructorId:   evt.instructorId    || '',
                instructorName: evt.instructorName  || '',
                studentId:      evt.studentId       || '',
                studentName:    evt.studentName     || '',
                timesheetCode:  evt.timesheetCode   || '',
                licenceName:    evt.driverlicenceName || '',
                vehicleId:      evt.vehicleId       || '',
                vehicleName:    evt.vehicleName     || '',
                description:    evt.description     || '',
            };
        });
    }

    // =========================================================
    // DOM SNAPSHOT
    // =========================================================
    function getDomSnapshot() {
        const snap = {};
        document.querySelectorAll('input, select, textarea').forEach(el => {
            const key = el.name || el.id || (el.className && el.className.trim().split(' ')[0]);
            if (!key) return;
            if (el.tagName === 'SELECT') {
                snap[key] = { value: el.value, text: el.options[el.selectedIndex] ? el.options[el.selectedIndex].textContent.trim() : '' };
            } else if (el.type === 'checkbox' || el.type === 'radio') {
                snap[key] = el.checked;
            } else {
                snap[key] = el.value;
            }
        });
        return snap;
    }

    // =========================================================
    // LOCATIE OPZOEKTABEL
    // =========================================================
    const LOCATIES = {
        '01':   'Kantoor Rijschool VTI Ieper',
        '02':   'KEURING/ONDERHOUD',
        '1010': 'Examencentrum Roeselare',
        '1011': 'Examencentrum Doornik',
        '1012': 'Examencentrum Brugge',
        '1013': 'Examencentrum Wevelgem',
        '1014': 'Euroshop Roeselare',
        'OEF':  'Oefenterrein Gullegem',
        'VORM': 'Vormingsmoment',
        'VTIR': 'VTIR Theorie rijbewijs C (ROES)',
    };

    // =========================================================
    // ACTIE HERKENNING
    // =========================================================
    function classify(url, method, rb, res) {
        const u = (url || '').toLowerCase();
        if (u.includes('add_exam') && method === 'POST')             return ['TOEVOEGEN',   'Examen'];
        if (u.includes('assign_exam'))
            return examCache[rb.id || ''] ? ['TOEKENNEN', 'Examen'] : ['TOEVOEGEN', 'Examen'];
        if (u.includes('assign_delete'))                             return ['LOSKOPPELEN', 'Examen'];
        if (u.includes('delete_exam'))                               return ['VERWIJDEREN', 'Examen'];
        if (u.includes('api/mail') && !u.includes('mailtemplate') && method === 'POST')
            return ['VERSTUREN', 'Mail'];
        if (u.includes('crud_payment_registration.php') && u.includes('add_payment_registrations') && method === 'POST')
            return ['BETALING', rb.paymentregistration_methode || 'ONBEKEND'];
        if (u.includes('crud_payment_registration.php') && u.includes('delete_payment_registrations') && method === 'POST')
            return ['BETALING', 'VERWIJDEREN'];
        if (u.includes('add_events.php') && method === 'POST') {
            if (rb.timesheetCode === 'LEAVE')                        return ['TOEVOEGEN', 'Verlof'];
            if (rb.timesheetCode === 'LESSON_SLOT')                  return ['TOEVOEGEN', 'Lesblok'];
            if (rb.timesheetCode === 'FREE_REG')                     return ['TOEVOEGEN', 'Planning (betaald)'];
            if (rb.timesheetCode === 'FREE_UNREG')                   return ['TOEVOEGEN', 'Planning (onbetaald)'];
            if (rb.studentName)                                      return ['TOEVOEGEN', 'Afspraak'];
            return ['TOEVOEGEN', 'Planning'];
        }
        if (u.includes('delete_events.php') && method === 'POST') {
            const cached = eventCache[rb.id] || {};
            if (cached.timesheetCode === 'LEAVE')       return ['VERWIJDEREN', 'Verlof'];
            if (cached.timesheetCode === 'LESSON_SLOT') return ['VERWIJDEREN', 'Lesblok'];
            if (cached.timesheetCode === 'FREE_REG')    return ['VERWIJDEREN', 'Planning (betaald)'];
            if (cached.timesheetCode === 'FREE_UNREG')  return ['VERWIJDEREN', 'Planning (onbetaald)'];
            const sid = rb.studentId || '';
            if (!sid || sid === 'undefined')            return ['VERWIJDEREN', 'Verlof'];
            return ['VERWIJDEREN', 'Lesblok'];
        }
        if (u.includes('update_events.php') && method === 'POST')           return ['WIJZIGEN',   'Afspraak'];
        if (u.includes('/api/event') && method === 'PUT') {
            if (examCache[rb.id || '']) return null;
            const resAny = res || {};
            const tsCode = (resAny.TimeSheetCode || (resAny.data && resAny.data.TimeSheetCode) || '').toUpperCase();
            if (tsCode === 'EXAM' || tsCode === 'LESSON_EXAM') return null;
            return ['TOEKENNEN', 'Lesblok'];
        }
        return null;
    }

    // =========================================================
    // STUUR NAAR GOOGLE SHEETS
    // =========================================================
    function sendToSheet(entry, actie, type) {
        const rb   = entry.requestBody  || {};
        const res  = entry.responseBody || {};
        const snap = entry.domSnapshot  || {};

        // ── EXAMEN ──────────────────────────────────────────────
        if (type === 'Examen') {
            const isToek = actie === 'TOEKENNEN';
            const fmtT   = t => ('' + t).length === 4 ? ('' + t).slice(0, 2) + ':' + ('' + t).slice(2) : ('' + t);

            if (actie === 'VERWIJDEREN') {
                const rawDate  = (snap.examDateInput || '').replace(/\//g, '-');
                const startT   = snap.examStartTimeInput || '';
                const endT     = snap.examEndTimeInput   || '';
                const timeslot = rawDate + (startT ? ' ' + startT : '') + (endT ? ' - ' + endT : '');
                const rawInstr   = snap.examInstructor || '';
                const instructor = rawInstr.replace(/^\[.*?\]\s*/, '') || snap.instructorName || '';
                const stuRaw   = snap.examStudent || '';
                const stuMatch = stuRaw.match(/^\[(.*?)\]\s*(.*)/);
                const studentId   = stuMatch ? stuMatch[1] : '';
                const studentName = stuMatch ? stuMatch[2] : stuRaw;
                const licRaw   = snap.examStudentLicence || '';
                const licMatch = licRaw.match(/^\[.*?\]\s*(.*)/);
                const license  = licMatch ? licMatch[1] : licRaw;
                const redenTekst = deleteReasonCache[String(rb.reasonId || '')] || '';
                const titleP     = (snap.examType || '').split(' - ');
                const examCentre = titleP.length >= 2 ? titleP[1] : '';
                const before     = (snap.examStartTravelTimeInput || '').trim();
                const after      = (snap.examEndTravelTimeInput   || '').trim();
                const examParts  = [];
                if (redenTekst) examParts.push('Reden: ' + redenTekst);
                if (examCentre) examParts.push(examCentre);
                if (before || after) examParts.push('Reistijd naar: ' + (before || '?') + ' van: ' + (after || '?'));
                const vRawDel    = snap.examVehicle || '';
                const vMatchDel  = vRawDel.match(/^\[(.*?)\]\s*(.*)/);
                const vehicleDel = vMatchDel ? vMatchDel[1] + ' - ' + vMatchDel[2] : vRawDel;
                const data = {
                    userEmail: GEBRUIKER, action: 'VERWIJDEREN', type: 'Examen',
                    instructor, studentName, studentId, timeslot,
                    vehicle: vehicleDel, license, eventId: rb.id || '',
                    description: '', params: examParts.join(' | ')
                };
                console.log('%c SHEET DATA (EXAMEN VERWIJDEREN):', 'color:#e67e22;font-weight:bold;', data);
                origFetch(SHEET_URL, { method: 'POST', mode: 'no-cors', body: JSON.stringify(data) }).catch(() => {});
                return;
            }

            if (actie === 'LOSKOPPELEN') {
                const rawDate  = (snap.examDateInput || '').replace(/\//g, '-');
                const startT   = snap.examStartTimeInput || '';
                const endT     = snap.examEndTimeInput   || '';
                const timeslot = rawDate + (startT ? ' ' + startT : '') + (endT ? ' - ' + endT : '');
                const rawInstr   = snap.examInstructor || '';
                const instructor = rawInstr.replace(/^\[.*?\]\s*/, '') || snap.instructorName || '';
                const stuRaw   = snap.examStudent || '';
                const stuMatch = stuRaw.match(/^\[(.*?)\]\s*(.*)/);
                const studentId   = stuMatch ? stuMatch[1] : '';
                const studentName = stuMatch ? stuMatch[2] : stuRaw;
                const licRaw   = snap.examStudentLicence || '';
                const licMatch = licRaw.match(/^\[.*?\]\s*(.*)/);
                const license  = licMatch ? licMatch[1] : licRaw;
                const vRaw    = snap.examVehicle || '';
                const vMatch  = vRaw.match(/^\[(.*?)\]\s*(.*)/);
                const vehicle = vMatch ? vMatch[1] + ' - ' + vMatch[2] : vRaw;
                const titleP     = (snap.examType || '').split(' - ');
                const examCentre = titleP.length >= 2 ? titleP[1] : '';
                const before     = (snap.examStartTravelTimeInput || '').trim();
                const after      = (snap.examEndTravelTimeInput   || '').trim();
                const rawPlace   = snap.appointmentPlace || '';
                const plaats     = rawPlace.replace(/^\[.*?\]\s*/, '');
                const examParts  = [];
                if (examCentre) examParts.push(examCentre);
                if (before || after) examParts.push('Reistijd naar: ' + (before || '?') + ' van: ' + (after || '?'));
                if (plaats) examParts.push('Plaats: ' + plaats);
                const data = {
                    userEmail: GEBRUIKER, action: 'LOSKOPPELEN', type: 'Examen',
                    instructor, studentName, studentId, timeslot,
                    vehicle, license, eventId: rb.id || '',
                    description: '', params: examParts.join(' | ')
                };
                console.log('%c SHEET DATA (EXAMEN LOSKOPPELEN):', 'color:#8e44ad;font-weight:bold;', data);
                origFetch(SHEET_URL, { method: 'POST', mode: 'no-cors', body: JSON.stringify(data) }).catch(() => {});
                return;
            }

            const examDate = res.date || '';
            const timeslot = examDate
                + (res.timestart ? ' ' + fmtT(res.timestart) : '')
                + (res.timeend   ? ' - ' + fmtT(res.timeend)  : '');
            const examCentreCode = isToek ? (examCache[rb.id || ''] || {}).event_place || '' : res.event_place || '';
            const examCentre     = LOCATIES[examCentreCode] || examCentreCode;
            let plaatsTekst = '';
            if (isToek) {
                plaatsTekst = LOCATIES[rb.event_place] || rb.event_place || '';
            } else {
                const rawPlace = snap.appointmentPlace || '';
                plaatsTekst = rawPlace.replace(/^\[.*?\]\s*/, '') || LOCATIES[rb.office] || '';
            }
            const before = res.exam_time_before != null ? res.exam_time_before + 'min' : '';
            const after  = res.exam_time_after  != null ? res.exam_time_after  + 'min' : '';
            const examParts = [];
            if (before || after) examParts.push('Reistijd naar: ' + (before || '?') + ' van: ' + (after || '?'));
            if (examCentre)      examParts.push(examCentre);
            if (plaatsTekst)     examParts.push('Plaats: ' + plaatsTekst);
            const rawInstr   = snap.examInstructor || '';
            const instructor = res.instructorName || rawInstr.replace(/^\[.*?\]\s*/, '') || snap.instructorName || '';
            const studentId  = (res.studentId === 'ex_slot' || !res.studentId) ? '' : res.studentId;
            const license    = isToek ? (res.driverlicenceName || res.driverlicenceId || '') : (res.licencetype || '');
            const vRaw    = snap.examVehicle || '';
            const vMatch  = vRaw.match(/^\[(.*?)\]\s*(.*)/);
            const vehicle = vMatch ? vMatch[1] + ' - ' + vMatch[2] : vRaw;
            const data = {
                userEmail: GEBRUIKER, action: actie, type,
                instructor, studentName: res.studentName || '', studentId,
                timeslot, vehicle, license,
                eventId: res.id || rb.id || '',
                description: '', params: examParts.join(' | ')
            };
            console.log('%c SHEET DATA (EXAMEN):', 'color:#e74c3c;font-weight:bold;', data);
            const payload = JSON.stringify(data);
            if (isToek) {
                setTimeout(() => origFetch(SHEET_URL, { method: 'POST', mode: 'no-cors', body: payload }).catch(() => {}), 600);
            } else {
                origFetch(SHEET_URL, { method: 'POST', mode: 'no-cors', body: payload }).catch(() => {});
            }
            return;
        }

        // ── BETALING ────────────────────────────────────────────
        if (actie === 'BETALING') {
            const studentId   = rb.customer_index || rb.id || snap.id || '';
            const studentName = ((snap.name || '') + ' ' + (snap.name2 || '')).trim();

            if (type !== 'VERWIJDEREN') {
                const knownIds = new Set(Object.keys(paymentCache));
                const data = {
                    userEmail: GEBRUIKER, action: 'BETALING', type,
                    instructor: '', studentName, studentId,
                    timeslot: '', vehicle: '', license: '', eventId: '',
                    description: rb.paymentregistration_description || '',
                    params: rb.paymentregistration_amount != null ? '€' + rb.paymentregistration_amount : ''
                };
                setTimeout(() => {
                    const newEntry = Object.values(paymentCache).find(p => !knownIds.has(String(p.id)));
                    if (newEntry) data.eventId = String(newEntry.id);
                    console.log('%c SHEET DATA (BETALING):', 'color:#f39c12;font-weight:bold;', data);
                    origFetch(SHEET_URL, { method: 'POST', mode: 'no-cors', body: JSON.stringify(data) }).catch(() => {});
                }, 500);
                return;
            }

            const cached = paymentCache[rb.index] || {};
            const data = {
                userEmail: GEBRUIKER, action: 'BETALING',
                type: cached.payment_methode || 'VERWIJDEREN',
                instructor: '', studentName, studentId,
                timeslot: '', vehicle: '', license: '',
                eventId: rb.index || '',
                description: cached.description || '',
                params: cached.amount != null ? '€' + cached.amount : ''
            };
            console.log('%c SHEET DATA (BETALING):', 'color:#f39c12;font-weight:bold;', data);
            origFetch(SHEET_URL, { method: 'POST', mode: 'no-cors', body: JSON.stringify(data) }).catch(() => {});
            return;
        }

        // ── MAIL ────────────────────────────────────────────────
        if (actie === 'VERSTUREN') {
            const studentId   = rb.studentId || snap.id || '';
            const studentName = ((snap.name || '') + ' ' + (snap.name2 || '')).trim();
            const data = {
                userEmail: GEBRUIKER, action: 'VERSTUREN', type: 'MAIL',
                instructor: '', studentName, studentId,
                timeslot: '', vehicle: '', license: '',
                eventId: res.id || '',
                description: rb.subject || '', params: ''
            };
            console.log('%c SHEET DATA (MAIL):', 'color:#3498db;font-weight:bold;', data);
            origFetch(SHEET_URL, { method: 'POST', mode: 'no-cors', body: JSON.stringify(data) }).catch(() => {});
            return;
        }

        // ── WIJZIGEN AFSPRAAK ────────────────────────────────────
        if (actie === 'WIJZIGEN') {
            const oldInstructor = snap.instructorName || (eventCache[rb.id] || {}).instructorName || '';
            const oldStartTime  = (snap.start || '').split(' ')[1] || '';
            const oldEndTime    = (snap.end   || '').split(' ')[1] || '';
            const oldTimePart   = oldStartTime + (oldEndTime ? ' - ' + oldEndTime : '');

            let newTimeslot = '';
            if (rb.start) {
                const [datePart, startFull] = rb.start.split(' ');
                const startTime     = startFull ? startFull.substring(0, 5) : '';
                const dateFormatted = datePart  ? datePart.split('-').reverse().join('-') : '';
                const endFull       = rb.end    ? rb.end.split(' ')[1] : '';
                const endTime       = endFull   ? endFull.substring(0, 5) : '';
                newTimeslot = dateFormatted + (startTime ? ' ' + startTime : '') + (endTime ? ' - ' + endTime : '');
            }

            const params = [
                oldInstructor ? 'Vorige instructeur: ' + oldInstructor : '',
                oldTimePart   ? 'Vorige tijd: ' + oldTimePart          : ''
            ].filter(Boolean).join(' | ');

            setTimeout(() => {
                const cached = eventCache[rb.id] || {};
                const vId    = rb.vehicleId   || cached.vehicleId   || '';
                const vNaam  = cached.vehicleName || '';
                const data   = {
                    userEmail: GEBRUIKER, action: 'WIJZIGEN', type: 'Afspraak',
                    instructor:  cached.instructorName || rb.instructorId || '',
                    studentName: cached.studentName    || '',
                    studentId:   rb.studentId          || cached.studentId || '',
                    timeslot:    newTimeslot,
                    vehicle:     vId && vNaam ? vId + ' - ' + vNaam : vId,
                    license:     rb.driverlicenceId    || '',
                    eventId:     rb.id                 || '',
                    description: '',
                    params
                };
                console.log('%c SHEET DATA (WIJZIGEN):', 'color:#3498db;font-weight:bold;', data);
                origFetch(SHEET_URL, { method: 'POST', mode: 'no-cors', body: JSON.stringify(data) }).catch(() => {});
            }, 500);
            return;
        }

        // ── LESBLOK / VERLOF / PLANNING ──────────────────────────
        const isDelete    = actie === 'VERWIJDEREN';
        const isToekennen = actie === 'TOEKENNEN';

        let timeslot = '';
        if (isToekennen) {
            const startStr = rb.start || '';
            const endStr   = rb.end   || '';
            if (startStr) {
                const [datePart, startTimeFull] = startStr.split(' ');
                const startTime     = startTimeFull ? startTimeFull.substring(0, 5) : '';
                const dateFormatted = datePart ? datePart.split('-').reverse().join('-') : '';
                const endTimeFull   = endStr ? endStr.split(' ')[1] : '';
                const endTime       = endTimeFull ? endTimeFull.substring(0, 5) : '';
                timeslot = dateFormatted + (startTime ? ' ' + startTime : '') + (endTime ? ' - ' + endTime : '');
            }
        } else {
            const startSrc = rb.start || snap.start || '';
            const endSrc   = rb.end   || snap.end   || '';
            if (startSrc) {
                const endTime = endSrc ? endSrc.split(' ').pop() : '';
                timeslot = startSrc + (endTime ? ' - ' + endTime : '');
            }
        }

        const eventId = (isDelete || isToekennen)
            ? (rb.id || '')
            : (res.eventId || (res.event && res.event.id) || (res.data && res.data.eventId) || '');

        const cached     = isDelete ? (eventCache[rb.id] || {}) : {};
        const instructor = rb.instructorName   || snap.instructorName   || cached.instructorName
                        || rb.instructorId     || rb.instructor
                        || snap.instructorId   || cached.instructorId   || '';

        const vPlaat = rb.vehicleId   || (isDelete && type === 'Lesblok' ? cached.vehicleId   : '') || '';
        const vNaam  = rb.vehicleName || (isDelete && type === 'Lesblok' ? cached.vehicleName : '') || '';
        const vehicle = vPlaat && vNaam ? vPlaat + ' - ' + vNaam : vPlaat || vNaam;

        const rawStudentId = (type === 'Verlof') ? '' : (
            isToekennen               ? (rb.student ? rb.student.id : (res.StudentId || '')) :
            (isDelete && type === 'Lesblok') ? (cached.studentId || '') :
            isDelete                  ? '' :
            (rb.studentId            || '')
        );
        const studentId    = (rawStudentId === 'undefined') ? '' : rawStudentId;

        const studentName  = (type === 'Verlof') ? '' : (
            isToekennen
                ? (rb.student ? (rb.student.FirstName + ' ' + rb.student.LastName).trim() : (res.StudentName || ''))
                : (isDelete && type === 'Lesblok')
                    ? (cached.studentName || '')
                    : (rb.studentName || '')
        );

        let params = '';
        if (isDelete && (type === 'Verlof' || type === 'Lesblok')) {
            const reden = (snap.deleteReasonDropDown && snap.deleteReasonDropDown.text) || rb.deletereason || '';
            params = reden ? 'Reden: ' + reden : '';
        } else if ((actie === 'TOEVOEGEN' || isToekennen) && type === 'Lesblok') {
            const placeCode = isToekennen
                ? ((rb.appointment_place && rb.appointment_place.Code) || res.AppointmentPlace || '')
                : (rb.appointment_place || '');
            const locTekst  = (snap.repeatlocation && snap.repeatlocation.text)
                           || LOCATIES[placeCode]
                           || placeCode;
            const rijbewijzen = isToekennen
                ? (res.LicenceName || res.LicenceId || '')
                : (Array.isArray(rb.driverlicenceTypes)
                    ? rb.driverlicenceTypes.map(function(t) { return t.name || t.code; }).join(', ')
                    : '');
            const delen = [];
            if (locTekst)    delen.push('Plaats: ' + locTekst);
            if (rijbewijzen) delen.push('Rijbewijs: ' + rijbewijzen);
            params = delen.join(' | ');
        } else if (type === 'Planning (onbetaald)' || type === 'Planning (betaald)') {
            params = '';
        } else if (type === 'Afspraak') {
            params = '';
        } else if (type !== 'Verlof') {
            params = VERSION + ' | req: ' + JSON.stringify(rb) + ' | res: ' + JSON.stringify(res);
        }

        const data = {
            userEmail:   GEBRUIKER,
            action:      actie,
            type:        type,
            instructor:  instructor,
            studentName: studentName,
            studentId:   studentId,
            timeslot:    timeslot,
            vehicle:     vehicle,
            license:     isToekennen                      ? (res.LicenceName || res.LicenceId || '') :
                         (isDelete && type === 'Lesblok') ? (cached.licenceName || '') :
                         type === 'Afspraak'              ? [rb.driverlicenceId, snap.title].filter(Boolean).join(' | ') :
                         (rb.licenceType || rb.driverlicenceId || ''),
            eventId:     eventId,
            description: type === 'Lesblok'
                ? (isDelete ? (cached.description || '') : (rb.description || ''))
                : (type === 'Planning (onbetaald)' || type === 'Planning (betaald)'
                    ? [rb.title, rb.description].filter(Boolean).join(' | ')
                    : ''),
            params:      params
        };

        console.log('%c SHEET DATA:', 'color:#27ae60;font-weight:bold;', data);
        origFetch(SHEET_URL, { method: 'POST', mode: 'no-cors', body: JSON.stringify(data) }).catch(() => {});
    }

    // =========================================================
    // KLEURCODERING
    // =========================================================
    const ACTION_MAP = [
        { match: 'assign_exam',   name: 'EXAMEN TOEWIJZEN',     color: '#e74c3c' },
        { match: 'add_events',    name: 'AFSPRAAK TOEVOEGEN',   color: '#2ecc71' },
        { match: 'delete_event',  name: 'AFSPRAAK VERWIJDEREN', color: '#e67e22' },
        { match: 'delete_exam',   name: 'EXAMEN VERWIJDEREN',   color: '#e67e22' },
        { match: 'update_event',  name: 'AFSPRAAK WIJZIGEN',    color: '#3498db' },
        { match: 'student',       name: 'LEERLING',             color: '#9b59b6' },
        { match: 'instructor',    name: 'INSTRUCTEUR',          color: '#1abc9c' },
        { match: 'vehicle',       name: 'VOERTUIG',             color: '#d35400' },
        { match: 'calendar',      name: 'KALENDER',             color: '#16a085' },
    ];

    function resolveAction(url) {
        const lower = url.toLowerCase();
        for (const a of ACTION_MAP) {
            if (lower.includes(a.match)) return a;
        }
        try {
            const path = new URL(url, location.origin).pathname;
            const last = path.split('/').filter(Boolean).pop() || url;
            return { name: last.toUpperCase(), color: '#7f8c8d' };
        } catch (_) {
            return { name: 'ONBEKEND', color: '#7f8c8d' };
        }
    }

    // =========================================================
    // GEOPEND LESBLOK (voor ID-Log knop)
    // =========================================================
    // Bij het openen van een bestaand lesblok vraagt BiqsDrive de voertuigen
    // op met event_id=<ID> in de URL. Bij een klik op ID-Log wordt enkel het
    // laatste verzoek gecontroleerd op een event_id.
    // Examens: bij het openen stuurt BiqsDrive geen ID mee. We zoeken het geopende
    // examen op in de laatst geladen kalendergegevens (events.php) aan de hand van
    // datum, begin-/einduur, examentype, instructeur en leerling uit het venster.
    const calendarEvents = {};   // alle geladen kalender-items, per ID

    function readField(name) {
        const el = document.querySelector('[name="' + name + '"]') || document.getElementById(name);
        if (!el) return null;
        const value = el.tagName === 'SELECT'
            ? (el.options[el.selectedIndex] ? el.options[el.selectedIndex].textContent.trim() : '')
            : (el.value || '').trim();
        return { el, value };
    }

    function isVisible(el) {
        return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    }

    // Geeft { id } terug, of { error } met een melding
    function findOpenExamId() {
        const dateF = readField('examDateInput');
        if (!dateF || !isVisible(dateF.el) || !dateF.value) return null;   // geen examen open

        const dm = dateF.value.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})$/);
        const startF = readField('examStartTimeInput');
        const endF   = readField('examEndTimeInput');
        if (!dm || !startF || !startF.value) return { error: 'Examen-ID niet gevonden (datum/uur onbekend)' };

        const isoDate = dm[3] + '-' + dm[2] + '-' + dm[1];
        const start   = isoDate + ' ' + startF.value.slice(0, 5);
        const end     = endF && endF.value ? isoDate + ' ' + endF.value.slice(0, 5) : '';

        const instrF = readField('examInstructor');
        const instrM = instrF && instrF.value.match(/^\[(.*?)\]/);
        const stuF   = readField('examStudent');
        const stuM   = stuF && stuF.value.match(/^\[(.*?)\]/);
        const typeF  = readField('examType');

        // Harde voorwaarden: echt examen (geen reistijd-blok EB_/EA_), zelfde datum + startuur,
        // en indien ingevuld: exact dezelfde instructeur en dezelfde leerling.
        let cands = Object.values(calendarEvents).filter(e => {
            const id   = String(e.id || '');
            const code = (e.timesheetCode || '').toUpperCase();
            if (!id || /^E[AB]_/.test(id) || code === 'EXAM_TIME' || !code.includes('EXAM')) return false;
            if ((e.start || '').slice(0, 16) !== start) return false;
            if (instrM && e.instructorId !== instrM[1] && e.resourceId !== instrM[1]) return false;
            if (stuM && e.studentId !== stuM[1]) return false;
            return true;
        });

        // Zachte voorwaarden: enkel toepassen als er nog iets overblijft
        const narrow = (fn) => {
            const f = cands.filter(fn);
            if (f.length) cands = f;
        };
        if (end) narrow(e => (e.end || '').slice(0, 16) === end);
        if (!stuM) narrow(e => !e.studentId || e.studentId === 'ex_slot');   // geen leerling → vrij slot
        if (typeF && typeF.value) narrow(e => (e.titleShort || '').trim() === typeF.value);

        console.log('%c ID-Log examen-zoektocht:', 'color:#f1c40f;font-weight:bold;',
            { start, end, instructeur: instrM ? instrM[1] : '', leerling: stuM ? stuM[1] : '',
              type: typeF ? typeF.value : '', gevonden: cands.map(e => e.id) });

        if (cands.length === 1) return { id: String(cands[0].id) };
        if (cands.length === 0) return { error: 'Examen-ID niet gevonden — herlaad de kalender (F5) en open het examen opnieuw' };
        return { error: 'Meerdere examens gevonden (' + cands.length + ') — zie console (F12)' };
    }

    function getLastEventId() {
        const last = captured[captured.length - 1];
        if (!last) return '';
        const m = (last.url || '').match(/[?&]event_id=([^&]*)/);
        if (!m) return '';
        let id;
        try { id = decodeURIComponent(m[1].replace(/\+/g, ' ')).trim(); } catch (_) { id = m[1].trim(); }
        return (id && id !== 'undefined' && id !== 'null') ? id : '';
    }

    function showStatus(text, color) {
        const el = document.getElementById('bds-status');
        if (!el) return;
        el.textContent = text;
        el.style.color = color;
        el.hidden = false;
        clearTimeout(showStatus._t);
        showStatus._t = setTimeout(() => { el.hidden = true; }, 4000);
    }

    // Geeft true terug als het kopiëren gelukt is
    async function copyToClipboard(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (_) {}
        // Fallback via verborgen textarea
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch (_) {
            return false;
        }
    }

    async function idLog() {
        // Eerst het laatste verzoek (lesblok), anders een geopend examen
        let id = getLastEventId();
        if (!id) {
            const exam = findOpenExamId();
            if (exam && exam.error) {
                showStatus(exam.error, '#e74c3c');
                return;
            }
            if (exam) id = exam.id;
        }
        if (!id) {
            showStatus('Selecteer eerst een lesblok of examen', '#e74c3c');
            return;
        }

        // 1. Eerst het ID in het klembord bewaren
        const copied = await copyToClipboard(id);
        if (copied) {
            showStatus('ID gekopieerd: ' + id, '#2ecc71');
        } else {
            showStatus('Kopiëren mislukt — ID: ' + id, '#e67e22');
        }

        // 2. Pas daarna een nieuw tabblad openen (moet binnen de klik gebeuren, anders blokkeert de popup-blokker)
        const tab = window.open('about:blank', '_blank');
        if (!tab) {
            showStatus('Nieuw tabblad geblokkeerd — sta pop-ups toe voor deze site', '#e74c3c');
            return;
        }
        try {
            tab.document.title = 'BiqsDrive ID-Log';
            tab.document.body.innerHTML = '<p style="font-family:sans-serif;padding:20px;">ID-Log wordt opgebouwd voor <b></b>…</p>';
            tab.document.querySelector('b').textContent = id;
        } catch (_) {}

        // 3. Apps Script vult het tabblad "ID-Log" en geeft het tabblad-nummer (gid) terug
        let target = SPREADSHEET_URL;
        try {
            const resp = await origFetch(SHEET_URL + '?eventId=' + encodeURIComponent(id) + '&format=json');
            const json = await resp.json();
            if (json && json.status === 'ok' && json.gid != null) {
                target = SPREADSHEET_URL + '#gid=' + json.gid;
            }
        } catch (e) {
            console.warn('ID-Log: filteren mislukt', e);
            showStatus('Filteren mislukt — spreadsheet wordt zonder filter geopend', '#e67e22');
        }

        // 4. Spreadsheet openen op het tabblad ID-Log
        tab.location.href = target;
    }

    // =========================================================
    // CENTRALE LOG
    // =========================================================
    const captured = [];

    function logEntry(entry) {
        captured.push(entry);

        if ((entry.url || '').toLowerCase().includes('events.php') && Array.isArray(entry.responseBody)) {
            updateEventCache(entry.responseBody);
            if (/(^|\/)events\.php/i.test(entry.url || '')) {
                entry.responseBody.forEach(e => { if (e && e.id) calendarEvents[e.id] = e; });
            }
        }

        if ((entry.url || '').toLowerCase().includes('delete_exam') && entry.status === 409) {
            const reasons = (entry.responseBody && entry.responseBody.data) || [];
            if (Array.isArray(reasons)) {
                reasons.forEach(r => { deleteReasonCache[String(r.id)] = r.description; });
            }
        }

        if ((entry.url || '').toLowerCase().includes('get_payment_registrations') && Array.isArray(entry.responseBody)) {
            entry.responseBody.forEach(p => { if (p.id) paymentCache[p.id] = p; });
        }

        if ((entry.url || '').toLowerCase().includes('add_exam') && entry.method === 'POST') {
            const r = entry.responseBody || {};
            if (r.id) examCache[r.id] = r;
        }

        const cls = classify(entry.url, entry.method, entry.requestBody || {}, entry.responseBody || {});
        if (cls) sendToSheet(entry, cls[0], cls[1]);

        const action = resolveAction(entry.url);
        const time   = new Date(entry.timestamp).toLocaleTimeString('nl-BE');

        console.group(
            '%c[' + time + '] ' + action.name + '  |  ' + entry.method + '  |  ' + (entry.status || '—'),
            'color:' + action.color + '; font-weight:bold; font-size:13px;'
        );
        console.log('%c URL:',      'color:#aaa', entry.url);
        console.log('%c Request:',  'color:#f39c12; font-weight:bold', entry.requestBody || '(leeg)');
        console.log('%c Response:', 'color:#2ecc71; font-weight:bold', entry.responseBody || '(leeg)');
        console.groupEnd();

        addPanelRow(entry, action, time);
    }

    // =========================================================
    // PANEEL
    // =========================================================
    let panelBody;

    function buildPanel() {
        const panel = document.createElement('div');
        panel.id = 'bds-panel';
        panel.style.cssText = 'position:fixed;top:10px;right:10px;width:420px;max-height:600px;background:#12121f;color:#eee;border:2px solid #2c2c4a;border-radius:8px;z-index:2147483647;font-family:monospace;font-size:11px;box-shadow:0 4px 24px rgba(0,0,0,.7);display:none;flex-direction:column;';

        const hdr = document.createElement('div');
        hdr.style.cssText = 'padding:8px 12px;background:#1e1e3a;border-radius:6px 6px 0 0;cursor:move;user-select:none;';
        hdr.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;">'
                      + '<span style="font-weight:bold;color:#e94560;font-size:13px;">BiqsDrive Logger ' + VERSION + '</span>'
                      + '<div style="display:flex;align-items:center;gap:8px;">'
                      + '<span id="bds-count" style="color:#7f8c8d;font-size:10px;">0 captures</span>'
                      + '<span id="bds-close" style="color:#e74c3c;cursor:pointer;font-size:18px;line-height:1;" title="Sluiten">&times;</span>'
                      + '</div>'
                      + '</div>'
                      + '<div style="color:#7f8c8d;font-size:10px;margin-top:2px;">'
                      + 'Gebruiker: <span style="color:#f1c40f;">' + GEBRUIKER + '</span>'
                      + '</div>'
                      + '<div id="bds-status" hidden style="font-size:11px;font-weight:bold;margin-top:3px;"></div>';

        const btnBar = document.createElement('div');
        btnBar.style.cssText = 'display:flex;gap:5px;padding:4px 10px;background:#16163a;';

        const mkBtn = (label, bg, fn, fg) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.style.cssText = 'background:' + bg + ';color:' + (fg || '#fff') + ';border:none;padding:3px 9px;border-radius:4px;cursor:pointer;font-size:11px;';
            b.onclick = fn;
            return b;
        };

        panelBody = document.createElement('div');
        panelBody.style.cssText = 'padding:6px;overflow-y:auto;flex:1;';

        btnBar.append(
            mkBtn('Clear', '#c0392b', () => { captured.length = 0; panelBody.innerHTML = ''; updateCount(); }),
            mkBtn('Export JSON', '#27ae60', exportJson),
            mkBtn('Min/Max', '#2980b9', () => {
                const hidden = panelBody.style.display === 'none';
                panelBody.style.display = hidden ? '' : 'none';
                btnBar.style.display    = hidden ? '' : 'none';
            }),
            mkBtn('ID-Log', '#f1c40f', idLog, '#12121f')
        );

        panel.append(hdr, btnBar, panelBody);
        document.body.appendChild(panel);
        makeDraggable(panel, hdr);
        document.getElementById('bds-close').onclick = () => { panel.style.display = 'none'; };
    }

    function updateCount() {
        const el = document.getElementById('bds-count');
        if (el) el.textContent = captured.length + ' capture' + (captured.length !== 1 ? 's' : '');
    }

    function addPanelRow(entry, action, time) {
        if (!panelBody) return;
        updateCount();

        const row = document.createElement('div');
        row.style.cssText = 'border-left:3px solid ' + action.color + ';padding:5px 8px;margin-bottom:5px;background:#1a1a30;border-radius:0 4px 4px 0;cursor:pointer;';

        const statusBadge = entry.status
            ? '<span style="float:right;color:' + (entry.status < 400 ? '#2ecc71' : '#e74c3c') + '">' + entry.status + '</span>'
            : '';

        row.innerHTML = '<div style="color:' + action.color + ';font-weight:bold;">' + statusBadge + '[' + time + '] ' + action.name + '</div>'
                      + '<div style="color:#7f8c8d;font-size:10px;word-break:break-all;">' + entry.url + '</div>'
                      + '<div style="color:#566573;font-size:10px;">Methode: ' + entry.method + '</div>';

        row.onclick = () => {
            const existing = row.querySelector('.bds-detail');
            if (existing) { existing.remove(); return; }
            const pre = document.createElement('pre');
            pre.className = 'bds-detail';
            pre.style.cssText = 'background:#0d0d1f;padding:8px;border-radius:4px;margin-top:6px;white-space:pre-wrap;word-break:break-all;font-size:9.5px;color:#a8e6cf;max-height:300px;overflow-y:auto;';
            pre.textContent = JSON.stringify({ url: entry.url, method: entry.method, status: entry.status, requestBody: entry.requestBody, responseBody: entry.responseBody }, null, 2);
            row.appendChild(pre);
        };

        panelBody.insertBefore(row, panelBody.firstChild);
    }

    function exportJson() {
        const blob = new Blob([JSON.stringify(captured, null, 2)], { type: 'application/json' });
        const a    = document.createElement('a');
        a.href     = URL.createObjectURL(blob);
        a.download = 'biqs-debug-' + Date.now() + '.json';
        a.click();
    }

    function makeDraggable(el, handle) {
        let ox = 0, oy = 0;
        handle.onmousedown = (e) => {
            ox = e.clientX - el.offsetLeft;
            oy = e.clientY - el.offsetTop;
            document.onmousemove = (ev) => {
                el.style.left  = (ev.clientX - ox) + 'px';
                el.style.top   = (ev.clientY - oy) + 'px';
                el.style.right = 'auto';
            };
            document.onmouseup = () => { document.onmousemove = null; document.onmouseup = null; };
        };
    }

    // =========================================================
    // XHR INTERCEPTIE
    // =========================================================
    XMLHttpRequest.prototype.open = function (method, url) {
        this._bds_url    = url;
        this._bds_method = method.toUpperCase();
        return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
        const t0   = Date.now();
        const snap = getDomSnapshot();
        this.addEventListener('load', () => {
            logEntry({
                timestamp:    new Date().toISOString(),
                duration:     (Date.now() - t0) + 'ms',
                method:       this._bds_method || 'XHR',
                url:          this._bds_url    || '?',
                status:       this.status,
                requestBody:  parseBody(body),
                responseBody: parseBody(this.responseText),
                domSnapshot:  snap,
            });
        });
        return origSend.apply(this, arguments);
    };

    // =========================================================
    // FETCH INTERCEPTIE
    // =========================================================
    window.fetch = async function (input, init) {
        if (!init) init = {};
        const url    = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
        const method = (init.method || 'GET').toUpperCase();
        const t0     = Date.now();
        const snap   = getDomSnapshot();

        const response = await origFetch.apply(this, arguments);
        response.clone().text().then(text => {
            logEntry({
                timestamp:    new Date().toISOString(),
                duration:     (Date.now() - t0) + 'ms',
                method,
                url,
                status:       response.status,
                requestBody:  parseBody(init.body),
                responseBody: parseBody(text),
                domSnapshot:  snap,
            });
        }).catch(() => {});
        return response;
    };

    // =========================================================
    // START
    // =========================================================
    // Interceptie start meteen (document_start), paneel pas als body beschikbaar is
    if (document.body) {
        buildPanel();
    } else {
        document.addEventListener('DOMContentLoaded', buildPanel);
    }

    document.addEventListener('keydown', function(e) {
        if (e.ctrlKey && e.altKey && e.code === 'KeyL') {
            const panel = document.getElementById('bds-panel');
            if (panel) panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
        }
    });

    (function checkAndLogUpdate() {
        const KEY    = 'bds_version';
        const stored = localStorage.getItem(KEY);
        if (stored !== null && stored !== VERSION) {
            origFetch(SHEET_URL, {
                method: 'POST',
                mode:   'no-cors',
                body:   JSON.stringify({
                    userEmail: GEBRUIKER, action: 'UPDATE', type: VERSION,
                    instructor: '', studentName: '', studentId: '',
                    timeslot: '', vehicle: '', license: '',
                    eventId: '', description: '', params: 'Vorige versie: ' + stored
                })
            }).catch(() => {});
        }
        localStorage.setItem(KEY, VERSION);
    })();

    console.log('%c BiqsDrive Logger ' + VERSION + ' actief — gebruiker: ' + GEBRUIKER, 'background:#e94560;color:#fff;padding:6px 12px;font-size:14px;border-radius:4px;');

})();
