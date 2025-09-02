import { Hono } from 'npm:hono';
import { cors } from 'npm:hono/cors';
import { logger } from 'npm:hono/logger';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import * as kv from './kv_store.tsx';

const app = new Hono();

// Middleware
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

app.use('*', logger(console.log));

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

// Helper function to get user ID from access token
async function getUserId(request: Request): Promise<string | null> {
  const accessToken = request.headers.get('Authorization')?.split(' ')[1];
  if (!accessToken) return null;

  const { data: { user }, error } = await supabase.auth.getUser(accessToken);
  if (error || !user?.id) {
    console.log('Authentication error while getting user ID:', error);
    return null;
  }
  
  return user.id;
}

// Helper function to generate unique ID
function generateId(): string {
  return 'txn_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

// Authentication Routes
app.post('/make-server-8b4b78bc/signup', async (c) => {
  try {
    const { email, password, name } = await c.req.json();

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      user_metadata: { name },
      // Automatically confirm the user's email since an email server hasn't been configured.
      email_confirm: true
    });

    if (error) {
      console.log('Signup error:', error);
      return c.json({ error: error.message }, 400);
    }

    return c.json({ user: data.user });
  } catch (error) {
    console.log('Server error during signup:', error);
    return c.json({ error: 'Internal server error during signup' }, 500);
  }
});

// Transaction Routes
app.get('/make-server-8b4b78bc/transactions', async (c) => {
  try {
    const userId = await getUserId(c.req.raw);
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const transactions = await kv.getByPrefix(`transaction:${userId}:`);
    return c.json(transactions || []);
  } catch (error) {
    console.log('Error fetching transactions:', error);
    return c.json({ error: 'Failed to fetch transactions' }, 500);
  }
});

app.post('/make-server-8b4b78bc/transactions', async (c) => {
  try {
    const userId = await getUserId(c.req.raw);
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const { amount, type, category, description, date } = await c.req.json();
    
    const transaction = {
      id: generateId(),
      amount: parseFloat(amount),
      type,
      category,
      description,
      date,
      userId,
      createdAt: new Date().toISOString()
    };

    await kv.set(`transaction:${userId}:${transaction.id}`, transaction);
    
    // Update budget spending if it's an expense
    if (type === 'expense') {
      await updateBudgetSpending(userId, category, parseFloat(amount));
    }

    return c.json(transaction);
  } catch (error) {
    console.log('Error creating transaction:', error);
    return c.json({ error: 'Failed to create transaction' }, 500);
  }
});

app.put('/make-server-8b4b78bc/transactions/:id', async (c) => {
  try {
    const userId = await getUserId(c.req.raw);
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const id = c.req.param('id');
    const { amount, type, category, description, date } = await c.req.json();
    
    // Get existing transaction to check ownership and old amount
    const existingTransaction = await kv.get(`transaction:${userId}:${id}`);
    if (!existingTransaction) {
      return c.json({ error: 'Transaction not found' }, 404);
    }

    const updatedTransaction = {
      ...existingTransaction,
      amount: parseFloat(amount),
      type,
      category,
      description,
      date,
      updatedAt: new Date().toISOString()
    };

    await kv.set(`transaction:${userId}:${id}`, updatedTransaction);
    
    // Update budget spending
    if (existingTransaction.type === 'expense') {
      await updateBudgetSpending(userId, existingTransaction.category, -existingTransaction.amount);
    }
    if (type === 'expense') {
      await updateBudgetSpending(userId, category, parseFloat(amount));
    }

    return c.json(updatedTransaction);
  } catch (error) {
    console.log('Error updating transaction:', error);
    return c.json({ error: 'Failed to update transaction' }, 500);
  }
});

app.delete('/make-server-8b4b78bc/transactions/:id', async (c) => {
  try {
    const userId = await getUserId(c.req.raw);
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const id = c.req.param('id');
    
    // Get existing transaction to update budget
    const existingTransaction = await kv.get(`transaction:${userId}:${id}`);
    if (!existingTransaction) {
      return c.json({ error: 'Transaction not found' }, 404);
    }

    await kv.del(`transaction:${userId}:${id}`);
    
    // Update budget spending if it was an expense
    if (existingTransaction.type === 'expense') {
      await updateBudgetSpending(userId, existingTransaction.category, -existingTransaction.amount);
    }

    return c.json({ success: true });
  } catch (error) {
    console.log('Error deleting transaction:', error);
    return c.json({ error: 'Failed to delete transaction' }, 500);
  }
});

// Budget Routes
app.get('/make-server-8b4b78bc/budgets', async (c) => {
  try {
    const userId = await getUserId(c.req.raw);
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const budgets = await kv.getByPrefix(`budget:${userId}:`);
    
    // Calculate spending for each budget
    const transactions = await kv.getByPrefix(`transaction:${userId}:`);
    const budgetsWithSpending = (budgets || []).map(budget => {
      const categorySpending = transactions
        .filter(t => t.type === 'expense' && t.category === budget.category)
        .reduce((sum, t) => sum + t.amount, 0);
      
      return {
        ...budget,
        spent: categorySpending,
        remaining: budget.amount - categorySpending
      };
    });

    return c.json(budgetsWithSpending);
  } catch (error) {
    console.log('Error fetching budgets:', error);
    return c.json({ error: 'Failed to fetch budgets' }, 500);
  }
});

app.post('/make-server-8b4b78bc/budgets', async (c) => {
  try {
    const userId = await getUserId(c.req.raw);
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const { category, amount, period } = await c.req.json();
    
    const budget = {
      id: generateId(),
      category,
      amount: parseFloat(amount),
      period,
      userId,
      createdAt: new Date().toISOString()
    };

    await kv.set(`budget:${userId}:${budget.id}`, budget);

    return c.json(budget);
  } catch (error) {
    console.log('Error creating budget:', error);
    return c.json({ error: 'Failed to create budget' }, 500);
  }
});

app.put('/make-server-8b4b78bc/budgets/:id', async (c) => {
  try {
    const userId = await getUserId(c.req.raw);
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const id = c.req.param('id');
    const { category, amount, period } = await c.req.json();
    
    const existingBudget = await kv.get(`budget:${userId}:${id}`);
    if (!existingBudget) {
      return c.json({ error: 'Budget not found' }, 404);
    }

    const updatedBudget = {
      ...existingBudget,
      category,
      amount: parseFloat(amount),
      period,
      updatedAt: new Date().toISOString()
    };

    await kv.set(`budget:${userId}:${id}`, updatedBudget);

    return c.json(updatedBudget);
  } catch (error) {
    console.log('Error updating budget:', error);
    return c.json({ error: 'Failed to update budget' }, 500);
  }
});

app.delete('/make-server-8b4b78bc/budgets/:id', async (c) => {
  try {
    const userId = await getUserId(c.req.raw);
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const id = c.req.param('id');
    
    const existingBudget = await kv.get(`budget:${userId}:${id}`);
    if (!existingBudget) {
      return c.json({ error: 'Budget not found' }, 404);
    }

    await kv.del(`budget:${userId}:${id}`);

    return c.json({ success: true });
  } catch (error) {
    console.log('Error deleting budget:', error);
    return c.json({ error: 'Failed to delete budget' }, 500);
  }
});

// Data Management Routes
app.get('/make-server-8b4b78bc/export', async (c) => {
  try {
    const userId = await getUserId(c.req.raw);
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const transactions = await kv.getByPrefix(`transaction:${userId}:`);
    const budgets = await kv.getByPrefix(`budget:${userId}:`);

    const exportData = {
      transactions: transactions || [],
      budgets: budgets || [],
      exportDate: new Date().toISOString(),
      version: '1.0'
    };

    return c.json(exportData);
  } catch (error) {
    console.log('Error exporting data:', error);
    return c.json({ error: 'Failed to export data' }, 500);
  }
});

app.post('/make-server-8b4b78bc/import', async (c) => {
  try {
    const userId = await getUserId(c.req.raw);
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const { transactions = [], budgets = [] } = await c.req.json();

    // Import transactions
    for (const transaction of transactions) {
      const newTransaction = {
        ...transaction,
        id: generateId(),
        userId,
        importedAt: new Date().toISOString()
      };
      await kv.set(`transaction:${userId}:${newTransaction.id}`, newTransaction);
    }

    // Import budgets
    for (const budget of budgets) {
      const newBudget = {
        ...budget,
        id: generateId(),
        userId,
        importedAt: new Date().toISOString()
      };
      await kv.set(`budget:${userId}:${newBudget.id}`, newBudget);
    }

    return c.json({ 
      success: true, 
      imported: { 
        transactions: transactions.length, 
        budgets: budgets.length 
      } 
    });
  } catch (error) {
    console.log('Error importing data:', error);
    return c.json({ error: 'Failed to import data' }, 500);
  }
});

app.delete('/make-server-8b4b78bc/delete-account', async (c) => {
  try {
    const userId = await getUserId(c.req.raw);
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Delete all user data
    const transactions = await kv.getByPrefix(`transaction:${userId}:`);
    const budgets = await kv.getByPrefix(`budget:${userId}:`);

    // Delete all transactions
    for (const transaction of transactions || []) {
      await kv.del(`transaction:${userId}:${transaction.id}`);
    }

    // Delete all budgets
    for (const budget of budgets || []) {
      await kv.del(`budget:${userId}:${budget.id}`);
    }

    return c.json({ success: true });
  } catch (error) {
    console.log('Error deleting account data:', error);
    return c.json({ error: 'Failed to delete account data' }, 500);
  }
});

// Helper function to update budget spending
async function updateBudgetSpending(userId: string, category: string, amount: number) {
  try {
    const budgets = await kv.getByPrefix(`budget:${userId}:`);
    const budget = budgets?.find(b => b.category === category);
    
    if (budget) {
      // Budget spending is calculated dynamically, so no need to store it
      // This function is kept for future enhancements like notifications
    }
  } catch (error) {
    console.log('Error updating budget spending:', error);
  }
}

// Health check
app.get('/make-server-8b4b78bc/health', (c) => {
  return c.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Start server
Deno.serve(app.fetch);