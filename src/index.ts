import * as api from '@actual-app/api'
import { createScheduleForTransaction } from './schedule';

let { q, runQuery } = require('@actual-app/api');

//let api = require('@actual-app/api');

async function resolveTransactions(transactions: any[]) {
  if(transactions.length == 0) {
    return;
  }

  createScheduleForTransaction(transactions.pop(), true, true, false)
    .then(async () => await resolveTransactions(transactions));

}
(async () => {
    await api.init({
      // Budget data will be cached locally here, in subdirectories for each file.
      dataDir: '/tmp/budget',
      // This is the URL of your running server
      serverURL: 'yyyyyyyyyyy',
      // This is the password you use to log into the server
      password: 'xxxxxxx',
    });
  
    await api.downloadBudget('aaaaaaaaaaa');
  
    const query = q('transactions')
    .filter({
      schedule: null,
    })
    .select('*');

    let result = await runQuery(query);
    
    const keys = Object.keys(result.data);

    const inFilter: any[] = []
    keys.forEach(key => {

      const current = result.data[key];
      const matches = current.notes?.match(/\((\d{2})\/(\d{2})\)/);

      if(matches) {
        inFilter.push(current);
      }
    })

    await resolveTransactions(inFilter);
    
    await api.sync();

    await api.shutdown();
  })();