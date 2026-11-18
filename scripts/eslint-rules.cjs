'use strict';

function owner(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (/Function/.test(current.type) || current.type === 'Program') return current;
  }
  return null;
}

function clearedValue(node) {
  return node && ((node.type === 'Identifier' && node.name === 'undefined')
    || (node.type === 'Literal' && node.value === null)
    || (node.type === 'UnaryExpression' && node.operator === 'void'));
}

const releaseBeforeClose = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { release: 'closeSync 可能关闭后抛错；请先移交并清空 {{descriptor}} 的所有权，再关闭局部 fd，避免重复 close 和清理中断。' },
  },
  create(context) {
    const source = context.sourceCode;
    const functions = new Map();
    const identities = new WeakMap();
    let nextId = 0;
    const identity = object => {
      if (!identities.has(object)) identities.set(object, ++nextId);
      return identities.get(object);
    };
    function storage(node) {
      if (node.type === 'Identifier') {
        let scope = source.getScope(node);
        while (scope && !scope.set.has(node.name)) scope = scope.upper;
        return scope ? `variable:${identity(scope.set.get(node.name))}` : `global:${node.name}`;
      }
      if (node.type === 'ThisExpression') return `this:${identity(owner(node))}`;
      if (node.type === 'MemberExpression') {
        const base = storage(node.object);
        const property = !node.computed ? node.property.name : node.property.type === 'Literal' ? node.property.value : null;
        return base && property !== null ? `${base}.${property}` : null;
      }
      return null;
    }
    function record(node) {
      const key = owner(node);
      if (!functions.has(key)) functions.set(key, { closes: [], clears: [] });
      return functions.get(key);
    }
    function guardedByFinally(call, key) {
      for (let parent = call.parent; parent && parent !== owner(call); parent = parent.parent) {
        if (parent.type !== 'TryStatement' || !parent.finalizer || call.range[0] >= parent.finalizer.range[0]) continue;
        const first = parent.finalizer.body.find(statement => statement.type !== 'EmptyStatement');
        const clear = first?.type === 'ExpressionStatement' && first.expression;
        if (clear?.type === 'AssignmentExpression' && clear.operator === '='
          && clearedValue(clear.right) && storage(clear.left) === key) return true;
      }
      return false;
    }
    return {
      CallExpression(node) {
        const callee = node.callee;
        const name = callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression'
          ? (callee.computed ? callee.property.value : callee.property.name) : null;
        if (name !== 'closeSync' || node.arguments.length !== 1) return;
        const key = storage(node.arguments[0]);
        if (key) record(node).closes.push({ node, key });
      },
      AssignmentExpression(node) {
        if (node.operator !== '=' || !clearedValue(node.right)) return;
        const key = storage(node.left);
        if (key) record(node).clears.push({ node, key });
      },
      'Program:exit'() {
        for (const value of functions.values()) {
          for (const call of value.closes) {
            if (value.clears.some(clear => clear.key === call.key && clear.node.range[0] > call.node.range[1])
              && !guardedByFinally(call.node, call.key)) {
              context.report({ node: call.node, messageId: 'release', data: { descriptor: source.getText(call.node.arguments[0]) } });
            }
          }
        }
      },
    };
  },
};

// These owners publish locks shared by independent processes. Their cleanup
// boundary must use the shared inode check, even after a partial write fails.
const lockOwners = new Map([
  ['managed-mcp-state.js', 'acquireUntil'],
  ['target-service.js', 'lock'],
  ['guided-solve.js', 'serial'],
  ['solver-profiles.js', 'mutate'],
  ['target-config-drafts.js', 'transaction'],
]);
const ownedLockCleanup = {
  meta: { type: 'problem', schema: [], messages: {
    ownership: '共享锁清理必须使用 unlinkOwnedFileSync(file, identity) 核对本次 dev/ino；不可直接 unlinkSync 删除可能已属于其他调用的路径。',
  } },
  create(context) {
    const file = context.filename.replace(/\\/g, '/');
    const expected = file.includes('/packages/core/src/') && lockOwners.get(file.slice(file.lastIndexOf('/') + 1));
    if (!expected) return {};
    return { CallExpression(node) {
      const callee = node.callee;
      const name = callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression'
        ? (callee.computed ? callee.property.value : callee.property.name) : null;
      if (name !== 'unlinkSync') return;
      for (let current = node.parent; current; current = current.parent) {
        const functionName = current.type === 'FunctionDeclaration' ? current.id?.name
          : current.type === 'MethodDefinition' ? current.key.name : null;
        if (functionName === expected) { context.report({ node, messageId: 'ownership' }); return; }
      }
    } };
  },
};

// Limit this guard to known filesystem lifecycle operations and FileHandles. It
// does not claim that arbitrary callbacks or arbitrary object methods cannot throw.
const cleanupNames = new Set(['closeSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'unlinkOwnedFileSync']);
const noThrowingFsCleanupInFinally = {
  meta: { type: 'problem', schema: [], messages: {
    cleanup: '{{operation}} 可能抛错并覆盖主操作错误或中断后续清理；请在清理处捕获，或移入保存主错误优先级且执行全部清理步骤的封装。',
  } },
  create(context) {
    const source = context.sourceCode;
    const protectedGroups = new Map();
    const property = node => node.type === 'Identifier' ? node.name : node.type === 'Literal' ? node.value : null;
    function variable(identifier) {
      let scope = source.getScope(identifier);
      while (scope && !scope.set.has(identifier.name)) scope = scope.upper;
      return scope?.set.get(identifier.name);
    }
    function required(node) {
      return node?.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require'
        && node.arguments.length === 1 && node.arguments[0].type === 'Literal' ? node.arguments[0].value : null;
    }
    function selected(base, name) {
      if (base === 'fs') return name === 'promises' ? 'fs-promises' : name;
      if (base === 'fs-promises') return name === 'open' ? 'openAsync' : name;
      return base === 'owned-file' ? name : null;
    }
    function origin(node, seen) {
      const module = required(node);
      if (module === 'fs' || module === 'node:fs') return 'fs';
      if (module === 'fs/promises' || module === 'node:fs/promises') return 'fs-promises';
      if (typeof module === 'string' && /owned-file(?:\.js)?$/.test(module)) return 'owned-file';
      if (node?.type === 'Identifier') return binding(node, seen);
      if (node?.type === 'MemberExpression') return selected(origin(node.object, seen), property(node.property));
      return null;
    }
    function destructured(pattern, identifier, base) {
      if (pattern === identifier) return base;
      if (pattern.type === 'AssignmentPattern') return destructured(pattern.left, identifier, base);
      if (pattern.type !== 'ObjectPattern') return null;
      for (const entry of pattern.properties) {
        if (entry.type !== 'Property') continue;
        const found = destructured(entry.value, identifier, selected(base, property(entry.key)));
        if (found) return found;
      }
      return null;
    }
    function binding(identifier, seen = new Set()) {
      const value = variable(identifier);
      if (!value || seen.has(value)) return null;
      seen.add(value);
      for (const definition of value.defs) {
        const declaration = definition.node;
        if (definition.type === 'ImportBinding') {
          const module = definition.parent.source.value;
          const base = module === 'fs' || module === 'node:fs' ? 'fs'
            : module === 'fs/promises' || module === 'node:fs/promises' ? 'fs-promises'
              : /owned-file(?:\.js)?$/.test(module) ? 'owned-file' : null;
          return declaration.type === 'ImportSpecifier' && property(declaration.imported) !== 'default'
            ? selected(base, property(declaration.imported)) : base;
        }
        if (declaration.type === 'VariableDeclarator') {
          const base = origin(declaration.init, seen);
          return declaration.id.type === 'Identifier' ? base : destructured(declaration.id, definition.name, base);
        }
      }
      return null;
    }
    function promiseFs(node) {
      return node.type === 'Identifier' && binding(node) === 'fs-promises'
        || ['fs/promises', 'node:fs/promises'].includes(required(node))
        || node.type === 'MemberExpression' && property(node.property) === 'promises'
          && (node.object.type === 'Identifier' && binding(node.object) === 'fs' || ['fs', 'node:fs'].includes(required(node.object)));
    }
    function fileHandle(node, seen = new Set()) {
      if (node?.type === 'AwaitExpression') return fileHandle(node.argument, seen);
      if (node?.type === 'CallExpression') return node.callee.type === 'MemberExpression'
        && property(node.callee.property) === 'open' && promiseFs(node.callee.object)
        || node.callee.type === 'Identifier' && binding(node.callee) === 'openAsync';
      if (node?.type !== 'Identifier') return false;
      const value = variable(node); if (!value || seen.has(value)) return false;
      seen.add(value);
      return value.references.some(reference => reference.isWrite() && reference.writeExpr && fileHandle(reference.writeExpr, seen));
    }
    function operation(node) {
      if (node.callee.type === 'Identifier') {
        const name = binding(node.callee);
        return cleanupNames.has(name) ? name : null;
      }
      if (node.callee.type !== 'MemberExpression') return null;
      const callee = node.callee;
      const name = property(callee.property);
      if (name === 'close' && fileHandle(callee.object)) return 'FileHandle.close';
      if (!cleanupNames.has(name)) return null;
      const base = callee.object;
      return (base.type === 'Identifier' && ['fs', 'owned-file'].includes(binding(base))) || ['fs', 'node:fs'].includes(required(base)) ? name : null;
    }
    function containsThrow(node) {
      if (!node || typeof node !== 'object') return false;
      if (node.type === 'ThrowStatement') return true;
      if (/Function/.test(node.type)) return false;
      return Object.entries(node).some(([key, value]) => key !== 'parent' && (Array.isArray(value) ? value.some(containsThrow) : containsThrow(value)));
    }
    function record(node, name, protection) {
      if (!protection) context.report({ node, messageId: 'cleanup', data: { operation: name } });
      else { if (!protectedGroups.has(protection)) protectedGroups.set(protection, []); protectedGroups.get(protection).push({ node, name }); }
    }
    return { CallExpression(node) {
      const name = operation(node); if (!name) return;
      let protection;
      for (let current = node; current.parent; current = current.parent) {
        const parent = current.parent;
        if (parent.type === 'TryStatement') {
          if (current === parent.block && parent.handler && !containsThrow(parent.handler.body)
            && (name !== 'FileHandle.close' || node.parent.type === 'AwaitExpression')) protection ||= parent;
          if (current === parent.finalizer) {
            record(node, name, protection);
            return;
          }
        }
        if (/Function/.test(parent.type)) {
          const call = parent.parent;
          if (call?.type === 'CallExpression' && call.callee.type === 'MemberExpression'
            && property(call.callee.property) === 'finally' && call.arguments.includes(parent)) record(node, name, protection);
          return;
        }
      }
    }, 'Program:exit'() {
      // One catch around several cleanup calls allows the first failure to
      // bypass the later calls. Each cleanup needs its own protected step.
      for (const calls of protectedGroups.values()) if (calls.length > 1) {
        for (const { node, name } of calls.slice(0, -1)) context.report({ node, messageId: 'cleanup', data: { operation: name } });
      }
    } };
  },
};

module.exports = { rules: { 'release-before-close': releaseBeforeClose, 'owned-lock-cleanup': ownedLockCleanup,
  'no-throwing-fs-cleanup-in-finally': noThrowingFsCleanupInFinally } };
