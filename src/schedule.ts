import * as dateFns from 'date-fns';
import * as api from '@actual-app/api'
let { q, runQuery } = require('@actual-app/api');

function extractScheduleConds(conditions) {
    return {
        payee:
        conditions.find(cond => cond.op === 'is' && cond.field === 'payee') ||
        conditions.find(
            cond => cond.op === 'is' && cond.field === 'description',
        ) ||
        null,
        account:
        conditions.find(cond => cond.op === 'is' && cond.field === 'account') ||
        conditions.find(cond => cond.op === 'is' && cond.field === 'acct') ||
        null,
        amount:
        conditions.find(
            cond =>
                (cond.op === 'is' ||
                cond.op === 'isapprox' ||
                cond.op === 'isbetween') &&
                cond.field === 'amount',
            ) || null,
            date:
            conditions.find(
                cond =>
                    (cond.op === 'is' || cond.op === 'isapprox') && cond.field === 'date',
            ) || null,
        };
    }
    function updateScheduleConditions(schedule, fields) {
        const conds = extractScheduleConds(schedule._conditions);
        
        const updateCond = (cond, op, field, value) => {
            if (cond) {
                return { ...cond, value };
            }
            
            if (value != null) {
                return { op, field, value };
            }
            
            return null;
        };
        
        // Validate
        if (fields.date == null) {
            return { error: 'Date is required' };
        }
        
        if (fields.amount == null) {
            return { error: 'A valid amount is required' };
        }
        
        return {
            conditions: [
                updateCond(conds.payee, 'is', 'payee', fields.payee),
                updateCond(conds.account, 'is', 'account', fields.account),
                updateCond(conds.date, 'isapprox', 'date', fields.date),
                // We don't use `updateCond` for amount because we want to
                // overwrite it completely
                {
                    op: fields.amountOp,
                    field: 'amount',
                    value: fields.amount,
                },
            ].filter(Boolean),
        };
    }
    
    function fromDateRepr(number: number) {
        if (typeof number !== 'number') {
            throw new Error('fromDateRepr not passed a number: ' + number);
        }
        
        const dateString = number.toString();
        return (
            dateString.slice(0, 4) +
            '-' +
            dateString.slice(4, 6) +
            '-' +
            dateString.slice(6)
        );
    }
    
    type DateLike = string | Date;
    
    function _parse(value: DateLike): Date {
        if (typeof value === 'string') {
            // Dates are hard. We just want to deal with months in the format
            // 2020-01 and days in the format 2020-01-01, but life is never
            // simple. We want to rely on native dates for date logic because
            // days are complicated (leap years, etc). But relying on native
            // dates mean we're exposed to craziness.
            //
            // The biggest problem is that JS dates work with local time by
            // default. We could try to only work with UTC, but there's not an
            // easy way to make `format` avoid local time, and not sure if we
            // want that anyway (`currentMonth` should surely print the local
            // time). We need to embrace local time, and as long as inputs to
            // date logic and outputs from format are local time, it should
            // work.
            //
            // To make sure we're in local time, always give Date integer
            // values. If you pass in a string to parse, different string
            // formats produce different results.
            //
            // A big problem is daylight savings, however. Usually, when
            // giving the time to the Date constructor, you get back a date
            // specifically for that time in your local timezone. However, if
            // daylight savings occurs on that exact time, you will get back
            // something different:
            //
            // This is fine:
            // > new Date(2017, 2, 12, 1).toString()
            // > 'Sun Mar 12 2017 01:00:00 GMT-0500 (Eastern Standard Time)'
            //
            // But wait, we got back a different time (3AM instead of 2AM):
            // > new Date(2017, 2, 12, 2).toString()
            // > 'Sun Mar 12 2017 03:00:00 GMT-0400 (Eastern Daylight Time)'
            //
            // The time is "correctly" adjusted via DST, but we _really_
            // wanted 2AM. The problem is that time simply doesn't exist.
            //
            // Why is this a problem? Well, consider a case where the DST
            // shift happens *at midnight* and it goes back an hour. You think
            // you have a date object for the next day, but when formatted it
            // actually shows the previous day. A more likely scenario: buggy
            // timezone data makes JS dates do this shift when it shouldn't,
            // so using midnight at the time for date logic gives back the
            // last day. See the time range of Sep 30 15:00 - Oct 1 1:00 for
            // the AEST timezone when nodejs-mobile incorrectly gives you back
            // a time an hour *before* you specified. Since this happens on
            // Oct 1, doing `addMonths(September, 1)` still gives you back
            // September. Issue here:
            // https://github.com/JaneaSystems/nodejs-mobile/issues/251
            //
            // The fix is simple once you understand this. Always use the 12th
            // hour of the day. That's it. There is no DST that shifts more
            // than 12 hours (god let's hope not) so no matter how far DST has
            // shifted backwards or forwards, doing date logic will stay
            // within the day we want.
            
            const [year, month, day] = value.split('-');
            if (day != null) {
                return new Date(parseInt(year), parseInt(month) - 1, parseInt(day), 12);
            } else if (month != null) {
                return new Date(parseInt(year), parseInt(month) - 1, 1, 12);
            } else {
                return new Date(parseInt(year), 0, 1, 12);
            }
        }
        if (typeof value === 'number') {
            return new Date(value);
        }
        return value;
    }      
    
    function currentDay(): string {
        return dateFns.format(new Date(), 'yyyy-MM-dd');
    }      
    
    export async function createScheduleForTransaction(
        trans,
        detectInstallments,
        updateDetectedInstallmentDate,
        ignoreAlreadyDetectedInstallments,
    ) {
        
        const dateValue = trans.date;
        if (detectInstallments && dateValue !== null && dateValue !== undefined) {
            const matches = trans.notes?.match(/\((\d{2})\/(\d{2})\)/);
            
            if (matches) {
                const installmentParcel = parseInt(matches[1]);
                const installmentParcelTotal = parseInt(matches[2]);
                
                let beginOfInstallment = dateValue;
                let endOfInstallment = dateValue;
                if (updateDetectedInstallmentDate) {
                    beginOfInstallment = dateFns.format(
                        dateFns.addMonths(
                            _parse(dateValue),
                            1 - installmentParcel,
                        ),
                        'yyyy-MM',
                    );
                    endOfInstallment = dateFns.format(dateFns.addMonths(
                        _parse(dateValue),
                        1 - installmentParcel + installmentParcelTotal,
                    ),
                    'yyyy-MM',
                    );
            }
            
            //const scheduleName = `${trans.notes.replace(matches[0], '').trim()} (at ${beginOfInstallment})`;
            const scheduleName = `${trans.notes.replace(matches[0], '').trim()}: ${installmentParcelTotal} parcelas de R$${trans.amount * -1 / 100} (${beginOfInstallment}:${endOfInstallment})`;
            
            const query = q('schedules')
            .filter({
                name: scheduleName,
            })
            .select('*');
            
            let { data } = await runQuery(query);
            
            let scheduleId: string | null = null;
            
            if (data.length === 0 || ignoreAlreadyDetectedInstallments) {
                const date = {
                    start: dateValue,
                    interval: 1,
                    frequency: 'monthly',
                    patterns: [],
                    skipWeekend: false,
                    weekendSolveMode: 'after',
                    endMode: 'after_n_occurrences',
                    endOccurrences: installmentParcelTotal - installmentParcel + 1,
                    endDate: currentDay(),
                    occurrences: Array(installmentParcelTotal - installmentParcel + 1)
                    .fill(dateValue)
                    .map((value, idx) =>
                        dateFns.format(
                        dateFns.addMonths(_parse(value), idx),
                        'yyyy-MM-dd',
                    ),
                ),
            };
            
            const schedule = {
                posts_transaction: false,
                _conditions: [{ op: 'isapprox', field: 'date', value: dateValue }],
                _actions: [],
                _account: trans.account,
                _amount: trans.amount,
                _amountOp: 'is',
                name: scheduleName,
                _payee: trans.payee ? trans.payee : '',
                _date: {
                    ...date,
                    frequency: 'monthly',
                    start: dateValue,
                    patterns: [],
                },
            };
            
            const state = {
                schedule,
                isCustom: false,
                fields: {
                    payee: schedule._payee,
                    account: schedule._account,
                    // defalut to a non-zero value so the sign can be changed before the value
                    amount: schedule._amount || -1000,
                    amountOp: schedule._amountOp || 'isapprox',
                    date: schedule._date,
                    posts_transaction: schedule.posts_transaction,
                    name: schedule.name,
                },
            };
            
            const { conditions } = updateScheduleConditions(
                state.schedule,
                state.fields,
            );
            
            scheduleId = await api.createSchedule(
                {
                    id: null,
                    posts_transaction: state.fields.posts_transaction,
                    name: state.fields.name,
                    completed: installmentParcel == installmentParcelTotal
                },
                conditions
            );
        } else {
            if(installmentParcel == installmentParcelTotal) {
                await api.updateSchedule({ id: data[0].id, completed: true }, null, false);
            }
            scheduleId = data[0].id;
        }
        
        await api.updateTransaction(trans.id,
            {
                schedule: scheduleId,
            });
        }
    }
}